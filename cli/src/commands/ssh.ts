/**
 * `heretic-cli ssh` — set up and verify the SSH tool-execution backend.
 *
 *   ssh presets            list the command presets
 *   ssh setup <profile>    key, authorized_keys, known_hosts, host PATH, presets → profile
 *   ssh check <profile>    verify key, host key, login, workspace dir and host commands
 *
 * For `docker-host` everything is done locally (the host is this machine);
 * for a remote host the key is installed with ssh-copy-id and the host key is
 * pinned with ssh-keyscan (trust on first use).
 */

import { Command } from "commander";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import inquirer from "inquirer";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import type { ResolvedAgentConfig, SshConfig, SshPreset } from "../types/agent-profile";
import { listProfiles, loadProfile, saveProfile } from "../utils/profile-loader";
import { promptList } from "../utils/prompt";
import { resolveConfig } from "../utils/config-resolver";
import {
  DOCKER_HOST_ALIAS,
  DOCKER_HOST_NAME,
  SSH_PRESET_DESCRIPTIONS,
  SSH_PRESET_NAMES,
  SSH_PRESETS,
  expandSshCommands,
  isDockerHostTarget,
  resolveSshHostName,
  validateSshCommands,
} from "../utils/ssh-presets";
import {
  PATH_CAPTURE_SCRIPT,
  authorizedKeyComment,
  listKeyPairs,
  managedKeyPath,
  publicKeyBody,
  removeAuthorizedKeyLines,
  removeHereticLinesForKey,
  buildAuthorizedKeysLine,
  buildKnownHostsLines,
  detectPresets,
  hasAuthorizedKey,
  knownHostsPattern,
  macProtectedFolder,
  parseCapturedPath,
  selectPresets,
} from "../utils/ssh-host";
import { buildSshBackendSpec, stageSshKey, writeSshClientFiles } from "../runners/ssh-backend";
import { getLogger, logRaw } from "../logger";

const logger = getLogger();

/** POSIX single-quote escaping for remote shell strings. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where `ssh setup` keeps generated keys and known_hosts files. */
function sshDir(): string {
  return join(homedir(), ".heretic", "ssh");
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "agent";
  }
}

/** How the CLI itself reaches the target (the container uses host.docker.internal). */
interface Target {
  /** Hostname/IP the CLI connects to */
  connectHost: string;
  /** Name the container uses; host keys are pinned under it */
  containerHost: string;
  port: number;
  user: string;
  keyPath: string;
  knownHosts?: string;
  local: boolean;
}

function sshArgs(t: Target, extra: string[] = []): string[] {
  const args = [
    "-p",
    String(t.port),
    "-i",
    t.keyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
  ];
  if (t.knownHosts && existsSync(t.knownHosts)) {
    args.push("-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${t.knownHosts}`);
    // Pin under the name the container uses; with a non-default port the
    // known_hosts entry is "[name]:port" and the alias must match it verbatim.
    args.push("-o", `HostKeyAlias=${knownHostsPattern(t.containerHost, t.port)}`);
  } else {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }
  return [...args, ...extra, `${t.user}@${t.connectHost}`];
}

/** Run one remote shell string; stdin closed, 30s budget. */
function runRemote(t: Target, script: string): SpawnSyncReturns<string> {
  return spawnSync("ssh", [...sshArgs(t), script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/** Remote script wrapped in the user's interactive login shell (sees nvm, rustup, brew…). */
function loginShell(script: string): string {
  return `exec "\${SHELL:-/bin/sh}" -lic ${q(script)}`;
}

function hostPrefix(hostPath?: string): string {
  return hostPath ? `PATH=${q(hostPath)}; export PATH; ` : "";
}

/** Which of `names` exist on the host (with the captured PATH, or a login shell). */
function probeCommands(t: Target, names: readonly string[], hostPath?: string): string[] | null {
  const list = names.map(q).join(" ");
  const loop = `for c in ${list}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done; exit 0`;
  const script = hostPath ? hostPrefix(hostPath) + loop : loginShell(loop);
  const res = runRemote(t, script);
  if (res.status !== 0) return null;
  const found = new Set(res.stdout.split(/\s+/).filter(Boolean));
  return names.filter((n) => found.has(n));
}

/** Hint for a failed login, chosen from ssh's error text. */
function sshdHint(local: boolean, stderr = ""): string {
  if (/host key|known_hosts/i.test(stderr)) {
    return "the host key does not match the pinned one: re-run `heretic-cli ssh setup` (or check for a MITM)";
  }
  if (/permission denied/i.test(stderr)) {
    return local
      ? "the key is not accepted: check ~/.ssh/authorized_keys and that sshd allows public-key login for this user"
      : "the key is not accepted: re-run setup without --no-authorize or add the .pub key on the host";
  }
  if (!local) return "check the host address, port, firewall and that sshd is running";
  if (process.platform === "darwin") {
    return "enable Remote Login: System Settings → General → Sharing → Remote Login (or `sudo systemsetup -setremotelogin on`)";
  }
  return "install and start sshd: `sudo apt install openssh-server && sudo systemctl enable --now ssh` (Fedora: `sudo dnf install openssh-server && sudo systemctl enable --now sshd`)";
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Public half of a private key: the `.pub` next to it, or derived with
 * `ssh-keygen -y`. A passphrase-protected key is rejected — the container
 * cannot type a passphrase (BatchMode).
 */
function readPublicKey(keyPath: string): string {
  const derived = spawnSync("ssh-keygen", ["-y", "-P", "", "-f", keyPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (derived.status !== 0) {
    throw new Error(
      `Cannot use ${keyPath}: ${/passphrase|incorrect/i.test(derived.stderr) ? "it is passphrase-protected (a container cannot enter a passphrase) — use a dedicated key without one" : (derived.stderr || "not a private key").trim()}`
    );
  }
  return existsSync(`${keyPath}.pub`) ? readFileSync(`${keyPath}.pub`, "utf8") : derived.stdout;
}

function ensureKey(keyPath: string, comment: string): void {
  if (existsSync(keyPath)) {
    // ssh ignores a group/world-readable private key ("UNPROTECTED PRIVATE KEY FILE")
    if (process.platform !== "win32" && statSync(keyPath).mode & 0o077) {
      chmodSync(keyPath, 0o600);
      logRaw(`  ✓ tightened ${keyPath} to 0600`);
    }
    return;
  }
  mkdirSync(join(keyPath, ".."), { recursive: true, mode: 0o700 });
  const res = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath, "-q"],
    {
      encoding: "utf8",
    }
  );
  if (res.status !== 0) {
    throw new Error(`ssh-keygen failed: ${res.stderr || res.error?.message || "unknown error"}`);
  }
  // Seen 0644 on Ubuntu 24.04 runners; ssh would then refuse the key.
  if (process.platform !== "win32") chmodSync(keyPath, 0o600);
  logRaw(`  ✓ generated key ${keyPath}`);
}

/**
 * Home directory from the user database (what sshd uses). Bun's
 * os.userInfo().homedir follows $HOME, so ask the shell's `~user` expansion.
 */
function passwdHome(): string {
  if (process.platform !== "win32") {
    const res = spawnSync("sh", ["-c", 'eval echo "~$(id -un)"'], { encoding: "utf8" });
    const home = res.stdout?.trim();
    if (res.status === 0 && home && home.startsWith("/")) return home;
  }
  return homedir();
}

/**
 * Append the key to this machine's ~/.ssh/authorized_keys (idempotent). Uses
 * the passwd home directory — the one sshd reads — not $HOME, which differs
 * under `sudo -E` and similar.
 */
function authorizeLocally(pubKey: string, comment: string, from?: string): void {
  const home = passwdHome();
  const dir = join(home, ".ssh");
  const file = join(dir, "authorized_keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // sshd (StrictModes) ignores authorized_keys when ~/.ssh or the home directory
  // is group/world-writable — e.g. a 0777 ~/.ssh as on GitHub's macOS runners.
  if (process.platform !== "win32") {
    if (statSync(dir).mode & 0o022) {
      chmodSync(dir, 0o700);
      logRaw(`  ✓ tightened ${dir} to 0700 (sshd refuses keys in a writable ~/.ssh)`);
    }
    if (statSync(home).mode & 0o022) {
      logRaw(
        `  ! ${home} is group/world-writable: sshd will refuse the key (chmod go-w "${home}")`
      );
    }
  }
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (hasAuthorizedKey(existing, pubKey)) {
    logRaw(`  ✓ key already in ${file}`);
    return;
  }
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${sep}${buildAuthorizedKeysLine(pubKey, comment, from)}\n`);
  chmodSync(file, 0o600);
  logRaw(`  ✓ authorized key in ${file} (restrict,pty${from ? `,from="${from}"` : ""})`);
}

/** Host public keys of this machine's sshd. */
function readLocalHostKeys(): string[] {
  const keys: string[] = [];
  for (const type of ["ed25519", "ecdsa", "rsa"]) {
    const file = `/etc/ssh/ssh_host_${type}_key.pub`;
    try {
      keys.push(readFileSync(file, "utf8"));
    } catch {
      // not present / not readable
    }
  }
  return keys;
}

function keyscan(host: string, port: number): string[] {
  const res = spawnSync("ssh-keyscan", ["-p", String(port), "-T", "10", host], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return res.status === 0 && res.stdout ? [res.stdout] : [];
}

interface SetupOptions {
  host?: string;
  port?: string;
  user?: string;
  presets?: string;
  commands?: string;
  from?: string;
  authorize?: boolean;
  /** Reuse this existing private key instead of creating one */
  key?: string;
}

function splitList(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runSshSetup(profileName: string, options: SetupOptions): Promise<void> {
  const profile = loadProfile(profileName);
  const current: Partial<SshConfig> = profile.ssh ?? {};

  const host = options.host ?? current.host ?? DOCKER_HOST_ALIAS;
  const local = isDockerHostTarget(host) || host === "localhost" || host === "127.0.0.1";
  const port = options.port ? Number(options.port) : (current.port ?? 22);
  const user = options.user ?? current.user ?? (local ? currentUser() : undefined);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (!user) {
    throw new Error("A remote host needs --user (the account to log in as)");
  }
  if (local && process.platform === "win32") {
    throw new Error(
      "SSH to the Docker host is not supported on Windows (cmd/PowerShell remote shell, unmappable paths). Use WSL or a Linux/macOS build host."
    );
  }

  const presetsOpt = splitList(options.presets) as SshPreset[] | undefined;
  const commandsOpt = splitList(options.commands);
  const fieldErrors = validateSshCommands({ presets: presetsOpt, commands: commandsOpt });
  if (fieldErrors.length > 0) throw new Error(fieldErrors.join("; "));

  const dir = sshDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = options.key
    ? resolvePath(expandHome(options.key))
    : (current.key_path ?? managedKeyPath(dir, profileName));
  if (options.key && !existsSync(keyPath)) throw new Error(`Key not found: ${keyPath}`);
  const knownHosts = current.known_hosts ?? join(dir, `${profileName}_known_hosts`);
  const comment = `heretic-${profileName}`;

  const target: Target = {
    connectHost: local ? "127.0.0.1" : resolveSshHostName(host),
    containerHost: local ? DOCKER_HOST_NAME : resolveSshHostName(host),
    port,
    user,
    keyPath,
    knownHosts,
    local,
  };

  logRaw(`SSH setup for profile '${profileName}' → ${user}@${target.containerHost}:${port}`);

  // 1. Key
  ensureKey(keyPath, comment);
  const pubKey = readPublicKey(keyPath);
  if (options.key) logRaw(`  ✓ reusing key ${keyPath}`);

  // 2. Authorize
  if (options.authorize !== false) {
    if (local) {
      authorizeLocally(pubKey, comment, options.from);
    } else {
      logRaw(
        `  → installing key on ${user}@${target.connectHost} (ssh-copy-id; may ask for a password)`
      );
      const res = spawnSync(
        "ssh-copy-id",
        ["-i", `${keyPath}.pub`, "-p", String(port), `${user}@${target.connectHost}`],
        { stdio: "inherit" }
      );
      if (res.status !== 0) {
        logRaw(
          `  ✗ ssh-copy-id failed; append ${keyPath}.pub to ~${user}/.ssh/authorized_keys on the host manually`
        );
      }
    }
  }

  // 3. Pin the host key under the name the container uses
  const hostKeys = local ? readLocalHostKeys() : [];
  if (hostKeys.length === 0) hostKeys.push(...keyscan(target.connectHost, port));
  const khLines = buildKnownHostsLines(target.containerHost, port, hostKeys);
  if (khLines.length > 0) {
    writeFileSync(knownHosts, khLines.join("\n") + "\n", { mode: 0o644 });
    logRaw(
      `  ✓ pinned ${khLines.length} host key(s) for ${knownHostsPattern(target.containerHost, port)} in ${knownHosts}`
    );
    if (!local) {
      logRaw("    (trust on first use — compare with `ssh-keygen -lf` output on the host)");
    }
  } else {
    logRaw(`  ! could not read the host keys; host-key checking stays disabled`);
  }
  const knownHostsField = khLines.length > 0 ? knownHosts : current.known_hosts;
  target.knownHosts = knownHostsField;

  // 4. Login + capture the interactive login-shell PATH
  const login = runRemote(target, loginShell(PATH_CAPTURE_SCRIPT));
  const hostPath = login.status === 0 ? parseCapturedPath(login.stdout) : undefined;

  let presets: SshPreset[] | undefined = presetsOpt ?? current.presets;
  if (login.status !== 0) {
    logRaw(`  ✗ cannot log in: ${(login.stderr || login.error?.message || "").trim()}`);
    logRaw(`    ${sshdHint(local, login.stderr)}`);
  } else {
    logRaw(`  ✓ login ok${hostPath ? "; captured host PATH" : ""}`);

    // 5. Detect toolchains
    const allCommands = SSH_PRESET_NAMES.flatMap((p) => [...SSH_PRESETS[p]]);
    const found = probeCommands(target, allCommands, hostPath);
    if (found) {
      const detections = detectPresets(found);
      logRaw("  Host toolchains:");
      for (const d of detections) {
        const mark = d.found.length > 0 ? "✓" : "·";
        logRaw(`    ${mark} ${d.preset.padEnd(10)} ${d.found.join(" ") || "-"}`);
      }
      if (!presets && !commandsOpt && !current.commands) {
        presets = selectPresets(detections);
        logRaw(`  → presets: ${presets.join(", ") || "(none found)"}`);
      }
    }
  }

  if (local && process.platform === "darwin") {
    const protectedDir = macProtectedFolder(process.cwd(), homedir());
    if (protectedDir) {
      logRaw(
        `  ! ${process.cwd()} is under ${protectedDir}: macOS blocks SSH sessions there unless sshd-keygen-wrapper has Full Disk Access (System Settings → Privacy & Security)`
      );
    }
  }
  if (local && process.platform === "linux") {
    logRaw(
      "  i containers connect from the Docker bridge (e.g. 172.17.0.1), not 127.0.0.1: sshd must listen there and the firewall must allow it. Verify with `heretic-cli ssh check " +
        profileName +
        " --container`"
    );
  }

  // 6. Save
  const next: SshConfig = {
    ...current,
    host,
    user,
    key_path: keyPath,
    ...(port !== 22 || current.port !== undefined ? { port } : {}),
    ...(knownHostsField ? { known_hosts: knownHostsField } : {}),
    ...(hostPath ? { host_path: hostPath } : {}),
    ...(presets ? { presets } : {}),
    ...(commandsOpt ? { commands: commandsOpt } : {}),
  };
  profile.ssh = next;
  saveProfile(profileName, profile);
  logRaw(`  ✓ saved ssh block to profile '${profileName}'`);
  logRaw(
    `  Routed when missing in the container: ${expandSshCommands(next).join(" ") || "(nothing)"}`
  );

  if (login.status !== 0) process.exitCode = 1;
}

interface CheckOptions {
  container?: boolean;
}

export async function runSshCheck(profileName: string, options: CheckOptions): Promise<void> {
  const projectDir = process.cwd();
  const config = resolveConfig({ profileName, projectDir });
  const ssh = config.ssh;
  if (!ssh) {
    throw new Error(
      `Profile '${profileName}' has no ssh block (run: heretic-cli ssh setup ${profileName})`
    );
  }

  let failed = false;
  const ok = (msg: string): void => logRaw(`  ✓ ${msg}`);
  const bad = (msg: string): void => {
    failed = true;
    logRaw(`  ✗ ${msg}`);
  };
  const warn = (msg: string): void => logRaw(`  ! ${msg}`);

  const spec = buildSshBackendSpec(config);
  if (!spec) return;
  const local = isDockerHostTarget(ssh.host);
  logRaw(
    `SSH check for '${profileName}' → ${spec.env.SSH_USER}@${spec.env.SSH_HOST}:${spec.env.SSH_PORT}`
  );

  // Key
  if (!ssh.key_path) {
    warn("no ssh.key_path: the container has no key unless the image ships one");
  } else if (!existsSync(ssh.key_path)) {
    bad(`key not found: ${ssh.key_path}`);
  } else {
    const mode = statSync(ssh.key_path).mode & 0o777;
    if (process.platform !== "win32" && mode & 0o077) {
      warn(
        `key ${ssh.key_path} has mode ${mode.toString(8)}; ssh-exec copies it to a private 0600 file`
      );
    } else {
      ok(`key ${ssh.key_path}`);
    }
  }

  // known_hosts
  if (ssh.known_hosts && existsSync(ssh.known_hosts)) {
    ok(`host keys pinned in ${ssh.known_hosts} (strict checking)`);
  } else {
    warn("no known_hosts: host-key checking disabled (MITM-able); run `heretic-cli ssh setup`");
  }

  const target: Target = {
    connectHost: local ? "127.0.0.1" : spec.env.SSH_HOST,
    containerHost: spec.env.SSH_HOST,
    port: Number(spec.env.SSH_PORT),
    user: spec.env.SSH_USER,
    keyPath: ssh.key_path ?? join(homedir(), ".ssh", "id_ed25519"),
    knownHosts: ssh.known_hosts,
    local,
  };

  // Login + workspace dir
  const hostCwd = spec.env.SSH_HOST_CWD;
  const cdCheck = hostCwd ? `cd ${q(hostCwd)} && ` : "";
  const script = hostPrefix(ssh.host_path) + `${cdCheck}echo ok`;
  const res = runRemote(target, ssh.host_path ? script : loginShell(script));
  if (res.status === 0 && res.stdout.includes("ok")) {
    ok(`login ok${hostCwd ? `; workspace ${hostCwd} exists on host` : ""}`);
  } else {
    bad(`login/cd failed (exit ${res.status}): ${(res.stderr || "").trim()}`);
    logRaw(`    ${sshdHint(local, res.stderr)}`);
  }

  // Commands
  const commands = expandSshCommands(ssh);
  if (res.status === 0 && commands.length > 0) {
    const found = probeCommands(target, commands, ssh.host_path);
    if (found) {
      const missing = commands.filter((c) => !found.includes(c));
      ok(`host has ${found.length}/${commands.length} listed commands: ${found.join(" ") || "-"}`);
      if (missing.length > 0) warn(`not on host (not routed): ${missing.join(" ")}`);
    }
  }

  // Real path: from a throwaway container on the Docker network
  if (options.container) {
    const run = runInThrowawayContainer(config, ["/opt/sidecar/ssh-exec", "--check"], "pipe");
    if (run.status === 0) {
      ok(`container → host works (${config.image})`);
    } else {
      bad(
        `container → host failed (exit ${run.status}): ${(run.stderr || run.error?.message || "").trim()}`
      );
    }
  }

  logRaw(failed ? "SSH backend: NOT ready" : "SSH backend: ready");
  if (failed) process.exitCode = 1;
}

/**
 * Run `command` in a throwaway container of the profile image with the same
 * SSH wiring `heretic-cli run` applies (env, key, known_hosts, host-gateway,
 * current ssh-exec + entrypoint), after generating the tool wrappers and the
 * host-run / auto-run launchers. The working directory follows the caller's
 * position inside the project.
 */
function runInThrowawayContainer(
  config: ResolvedAgentConfig,
  command: string[],
  stdio: "pipe" | "inherit"
): SpawnSyncReturns<string> {
  const ssh = config.ssh!;
  const files = ssh.mount_client === false ? undefined : writeSshClientFiles();
  const staged =
    ssh.key_path && existsSync(ssh.key_path) ? stageSshKey(ssh.key_path, config.name) : undefined;
  const spec = buildSshBackendSpec(config, files, staged)!;
  const workspace = spec.env.SSH_WORKSPACE;
  const rel = relative(config.projectDir, process.cwd());
  const workdir =
    rel && !rel.startsWith("..") && !isAbsolute(rel)
      ? `${workspace}/${rel.split(sep).join("/")}`
      : workspace;

  const prepare =
    'export PATH="/opt/sidecar/wrappers:$PATH"; ' +
    'source <(sed -n "/^setup_tool_wrappers() {/,/^}/p" /entrypoint.sh) && setup_tool_wrappers >&2; ' +
    'exec "$@"';
  const args = ["run", "--rm", "--entrypoint", "/bin/bash"];
  if (stdio === "inherit" && process.stdin.isTTY) args.push("-it");
  for (const h of spec.extraHosts) args.push("--add-host", h);
  for (const b of spec.binds) args.push("-v", b);
  for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
  args.push("-v", `${config.projectDir}:${workspace}`, "-w", workdir, config.image);
  args.push("-c", prepare, "heretic-ssh-exec", ...command);
  logger.debug({ args }, "ssh throwaway container");
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : "pipe",
    timeout: stdio === "inherit" ? undefined : 120_000,
  });
}

export async function runSshExec(profileName: string, command: string[]): Promise<void> {
  if (command.length === 0) {
    throw new Error("Nothing to run: heretic-cli ssh exec <profile> -- <command> [args...]");
  }
  const config = resolveConfig({ profileName, projectDir: process.cwd() });
  if (!config.ssh) {
    throw new Error(
      `Profile '${profileName}' has no ssh block (run: heretic-cli ssh setup ${profileName})`
    );
  }
  const run = runInThrowawayContainer(config, command, "inherit");
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
}

/** Public-key bodies of every other profile's SSH key (keys still in use). */
function keyBodiesInUse(exceptProfile: string): Set<string> {
  const bodies = new Set<string>();
  for (const name of listProfiles()) {
    if (name === exceptProfile) continue;
    try {
      const keyPath = loadProfile(name).ssh?.key_path;
      if (keyPath && existsSync(keyPath)) {
        const body = publicKeyBody(readPublicKey(keyPath));
        if (body) bodies.add(body);
      }
    } catch {
      // unreadable profile / key: nothing to protect
    }
  }
  return bodies;
}

/** Remove this profile's authorized_keys line(s) on this machine. */
function unauthorizeLocally(profileName: string, keep: Set<string>): number {
  const file = join(passwdHome(), ".ssh", "authorized_keys");
  if (!existsSync(file)) return 0;
  const { content, removed } = removeAuthorizedKeyLines(
    readFileSync(file, "utf8"),
    profileName,
    keep
  );
  if (removed > 0) writeFileSync(file, content); // keeps the file's mode
  return removed;
}

/** Drop all heretic lines for a key that no profile uses any more. */
function sweepUnusedKey(body: string | undefined, inUse: Set<string>): number {
  if (!body || inUse.has(body)) return 0;
  const file = join(passwdHome(), ".ssh", "authorized_keys");
  if (!existsSync(file)) return 0;
  const { content, removed } = removeHereticLinesForKey(readFileSync(file, "utf8"), body);
  if (removed > 0) writeFileSync(file, content);
  return removed;
}

/**
 * Revoke a profile's SSH access and delete the files `ssh setup` created for
 * it. Keys the user brought (`--key`, ~/.ssh/id_*) are never deleted, and an
 * authorized_keys line stays while another profile uses the same key.
 */
export function revokeSshAccess(profileName: string, ssh: SshConfig | undefined): string[] {
  const done: string[] = [];
  const dir = sshDir();
  const managedKey = managedKeyPath(dir, profileName);
  const inUse = keyBodiesInUse(profileName);

  if (!ssh || isLocalTarget(ssh.host)) {
    let removed = unauthorizeLocally(profileName, inUse);
    // The profile's key may also be authorized under another (deleted or
    // rotated-away) profile's line: drop those once nothing uses the key.
    if (ssh?.key_path && existsSync(ssh.key_path)) {
      try {
        removed += sweepUnusedKey(publicKeyBody(readPublicKey(ssh.key_path)), inUse);
      } catch {
        // unreadable key: nothing more to match
      }
    }
    if (removed > 0)
      done.push(`removed ${removed} authorized_keys line(s) for heretic-${profileName}`);
  } else {
    done.push(
      `remote host ${ssh.host}: remove the 'heretic-${profileName}' line from ~${ssh.user ?? "agent"}/.ssh/authorized_keys there`
    );
  }

  const managedInUse =
    existsSync(managedKey) &&
    ((): boolean => {
      try {
        const body = publicKeyBody(readPublicKey(managedKey));
        return body !== undefined && inUse.has(body);
      } catch {
        return false;
      }
    })();
  const files = [
    ...(managedInUse ? [] : [managedKey, `${managedKey}.pub`]),
    join(dir, `${profileName}_known_hosts`),
    join(dir, "run", `${profileName}.key`),
  ];
  for (const file of files) {
    if (existsSync(file)) {
      unlinkSync(file);
      done.push(`deleted ${file}`);
    }
  }
  return done;
}

function isLocalTarget(host: string | undefined): boolean {
  return isDockerHostTarget(host) || host === "localhost" || host === "127.0.0.1";
}

/** Replace a profile's key with a fresh dedicated one and revoke the old one. */
export async function runSshRotate(profileName: string): Promise<void> {
  const profile = loadProfile(profileName);
  const ssh = profile.ssh;
  if (!ssh?.key_path) {
    throw new Error(
      `Profile '${profileName}' has no SSH key (run: heretic-cli ssh setup ${profileName})`
    );
  }
  if (!isLocalTarget(ssh.host)) {
    throw new Error(
      "Rotation is automatic only for docker-host/localhost. For a remote host run `ssh setup` with a new --key, then remove the old line from authorized_keys there."
    );
  }
  const oldBody = publicKeyBody(readPublicKey(ssh.key_path));
  const dir = sshDir();
  const managed = managedKeyPath(dir, profileName);
  const fresh = `${managed}.new`;
  for (const f of [fresh, `${fresh}.pub`]) if (existsSync(f)) unlinkSync(f);
  ensureKey(fresh, authorizedKeyComment(profileName));
  const freshPub = readFileSync(`${fresh}.pub`, "utf8");
  authorizeLocally(freshPub, authorizedKeyComment(profileName));

  // Drop the old line unless another profile shares that key
  const keep = keyBodiesInUse(profileName);
  const freshBody = publicKeyBody(freshPub);
  if (freshBody) keep.add(freshBody);
  const removed =
    oldBody && !keep.has(oldBody)
      ? unauthorizeLocally(profileName, keep) + sweepUnusedKey(oldBody, keep)
      : 0;

  renameSync(fresh, managed);
  renameSync(`${fresh}.pub`, `${managed}.pub`);
  profile.ssh = { ...ssh, key_path: managed };
  saveProfile(profileName, profile);
  logRaw(
    `  ✓ new key ${managed} authorized${removed ? `; old key revoked (${removed} line(s))` : ""}`
  );
  if (ssh.key_path !== managed) logRaw(`  i your previous key ${ssh.key_path} was left untouched`);
  logRaw(`  Restart running agents of '${profileName}' to pick up the new key.`);
}

/**
 * Interactive SSH step for `heretic-cli init`: ask whether the agent may run
 * host toolchains, pick or create the key, then run `ssh setup`.
 */
export async function promptSshSetup(profileName: string): Promise<void> {
  const target = await promptList("Run builds/toolchains on a host over SSH for this agent?", [
    { name: "No", value: "no" },
    { name: "Yes — this machine (the Docker host)", value: "local" },
    { name: "Yes — a remote build host", value: "remote" },
  ]);
  if (target === "no") return;
  if (target === "local" && process.platform === "win32") {
    logRaw("  SSH to the Docker host is not supported on Windows — skipped.");
    return;
  }

  const options: SetupOptions = {};
  if (target === "remote") {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "host",
        message: "SSH host:",
        validate: (v: string): boolean | string => !!v.trim() || "required",
      },
      {
        type: "input",
        name: "user",
        message: "SSH user:",
        validate: (v: string): boolean | string => !!v.trim() || "required",
      },
      { type: "input", name: "port", message: "SSH port:", default: "22" },
    ]);
    options.host = answers.host.trim();
    options.user = answers.user.trim();
    options.port = answers.port.trim();
  }

  const candidates = [
    ...listKeyPairs(sshDir()).filter((k) => !k.endsWith(`${profileName}_ed25519`)),
    ...listKeyPairs(join(homedir(), ".ssh"), ["id_ed25519", "id_ecdsa", "id_rsa"]),
  ];
  const keyChoice = await promptList("SSH key for this agent:", [
    { name: "Create a dedicated key (recommended)", value: "__new" },
    ...candidates.map((k) => ({ name: `Reuse ${k}`, value: k })),
    { name: "Another key file…", value: "__path" },
  ]);
  if (keyChoice === "__path") {
    const answer = await inquirer.prompt([
      {
        type: "input",
        name: "key",
        message: "Path to the private key:",
        validate: (v: string): boolean | string => !!v.trim() || "required",
      },
    ]);
    options.key = answer.key.trim();
  } else if (keyChoice !== "__new") {
    options.key = keyChoice;
  }

  try {
    await runSshSetup(profileName, options);
    logRaw(`  Verify any time with: heretic-cli ssh check ${profileName} --container`);
  } catch (error) {
    logRaw(`  ✗ SSH setup failed: ${error instanceof Error ? error.message : String(error)}`);
    logRaw(`    Retry later with: heretic-cli ssh setup ${profileName}`);
  }
}

function runSshPresets(): void {
  logRaw("SSH command presets (routed only when missing in the container):\n");
  for (const name of SSH_PRESET_NAMES) {
    logRaw(`  ${name.padEnd(10)} ${SSH_PRESET_DESCRIPTIONS[name]}`);
    logRaw(`  ${"".padEnd(10)} ${SSH_PRESETS[name].join(" ")}`);
  }
  logRaw(
    "\nDefault when the ssh block names neither presets nor commands: node python java go rust"
  );
}

/** Run a subcommand action, printing failures as one error line + exit 1. */
function guarded<A extends unknown[]>(
  fn: (...args: A) => Promise<void> | void
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

export function createSshCommand(): Command {
  const ssh = new Command("ssh");
  ssh.description("Set up and verify the SSH tool-execution backend (host toolchains)");

  ssh
    .command("presets")
    .description("List the command presets the SSH backend can route")
    .action(guarded(() => runSshPresets()));

  ssh
    .command("setup")
    .description("Create a key, authorize it, pin the host key, capture PATH and pick presets")
    .argument("<profile>", "Agent profile to configure")
    .option("--host <host>", `SSH host (default: ${DOCKER_HOST_ALIAS} = this machine)`)
    .option("--port <port>", "SSH port (default: 22)")
    .option("--user <user>", "Login user (default: current user for docker-host)")
    .option(
      "--presets <list>",
      `Comma-separated presets (${SSH_PRESET_NAMES.join(", ")}); default: auto-detect`
    )
    .option("--commands <list>", "Comma-separated extra commands to route")
    .option("--from <cidr>", "Restrict the authorized key to these source addresses")
    .option("--key <path>", "Reuse an existing private key (default: create a dedicated one)")
    .option("--no-authorize", "Do not install the public key on the host")
    .action(
      guarded(async (profile: string, options: SetupOptions) => {
        await runSshSetup(profile, options);
      })
    );

  ssh
    .command("check")
    .description("Verify key, host key, login, workspace path and host commands")
    .argument("<profile>", "Agent profile to check")
    .option("--container", "Also test from a throwaway container of the profile image")
    .action(
      guarded(async (profile: string, options: CheckOptions) => {
        await runSshCheck(profile, options);
      })
    );

  ssh
    .command("rotate")
    .description(
      "Replace the profile's key with a new dedicated one and revoke the old (this machine)"
    )
    .argument("<profile>", "Agent profile")
    .action(
      guarded(async (profile: string) => {
        await runSshRotate(profile);
      })
    );

  ssh
    .command("revoke")
    .description("Remove the profile's authorized_keys line and the key files ssh setup created")
    .argument("<profile>", "Agent profile")
    .action(
      guarded((profile: string) => {
        let ssh: SshConfig | undefined;
        try {
          ssh = loadProfile(profile).ssh;
        } catch {
          // profile already gone: still clean up by name
        }
        const done = revokeSshAccess(profile, ssh);
        for (const line of done) logRaw(`  ✓ ${line}`);
        if (done.length === 0) logRaw("  nothing to revoke");
        if (ssh) {
          try {
            const p = loadProfile(profile);
            delete p.ssh;
            saveProfile(profile, p);
            logRaw(`  ✓ removed the ssh block from profile '${profile}'`);
          } catch {
            // ignore
          }
        }
      })
    );

  ssh
    .command("exec")
    .description(
      "Run a command in a throwaway container of the profile image with the SSH backend wired (wrappers, host-run, auto-run)"
    )
    .argument("<profile>", "Agent profile")
    .argument("[command...]", "Command to run in the container (put it after --)")
    .action(
      guarded(async (profile: string, command: string[]) => {
        await runSshExec(profile, command);
      })
    );

  return ssh;
}
