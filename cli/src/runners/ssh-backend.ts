/**
 * SSH backend wiring shared by the docker and compose runners.
 *
 * Turns a resolved `ssh:` block into the container env (SSH_*), read-only
 * binds for the key / known_hosts, the `host-gateway` alias for the Docker
 * host, and — unless disabled — binds of the CLI's current `ssh-exec` and
 * entrypoint over the image's copies, so older images get the current client
 * without a rebuild.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { ResolvedAgentConfig } from "../types/agent-profile";
import { generateEntrypoint, SSH_EXEC_SCRIPT } from "../templates";
import {
  DOCKER_HOST_NAME,
  expandSshCommands,
  isDockerHostTarget,
  resolveSshHostName,
} from "../utils/ssh-presets";

/** In-container locations (outside ~/.ssh so Docker does not create a root-owned ~/.ssh). */
export const SSH_KEY_TARGET = "/etc/heretic/ssh/key";
export const SSH_KNOWN_HOSTS_TARGET = "/etc/heretic/ssh/known_hosts";
export const SSH_EXEC_TARGET = "/opt/sidecar/ssh-exec";
export const ENTRYPOINT_TARGET = "/entrypoint.sh";

export interface SshBackendSpec {
  /** Environment variables for the agent container */
  env: Record<string, string>;
  /** Bind specs "<host>:<container>:ro" */
  binds: string[];
  /** extra_hosts / ExtraHosts entries */
  extraHosts: string[];
}

/** Host user name, falling back to "agent" when the OS cannot tell. */
function currentUser(): string {
  try {
    return userInfo().username || "agent";
  } catch {
    return "agent";
  }
}

/**
 * Container workspace root: the target of the volume mounting the project
 * directory, else the working directory, else /workspace.
 */
export function resolveWorkspaceTarget(config: ResolvedAgentConfig): string {
  const vol = config.volumes.find((v) => v.source === config.projectDir);
  return vol?.target || config.workdir || "/workspace";
}

/**
 * Pure: compute env, binds and extra hosts. `clientFiles` are the host paths of
 * the ssh-exec / entrypoint overrides when they should be mounted.
 */
export function buildSshBackendSpec(
  config: ResolvedAgentConfig,
  clientFiles?: { sshExec: string; entrypoint: string },
  stagedKeyPath?: string
): SshBackendSpec | undefined {
  const ssh = config.ssh;
  if (!ssh) return undefined;

  const dockerHost = isDockerHostTarget(ssh.host);
  const env: Record<string, string> = {
    SSH_HOST: resolveSshHostName(ssh.host),
    SSH_PORT: String(ssh.port ?? 22),
    SSH_USER: ssh.user ?? (dockerHost ? currentUser() : "agent"),
    SSH_WORKSPACE: resolveWorkspaceTarget(config),
    SSH_COMMANDS: expandSshCommands(ssh).join(" "),
  };
  const binds: string[] = [];
  const extraHosts: string[] = [];

  if (ssh.key_path) {
    env.SSH_KEY_PATH = SSH_KEY_TARGET;
    binds.push(`${stagedKeyPath ?? ssh.key_path}:${SSH_KEY_TARGET}:ro`);
  }
  if (ssh.known_hosts) {
    env.SSH_KNOWN_HOSTS = SSH_KNOWN_HOSTS_TARGET;
    binds.push(`${ssh.known_hosts}:${SSH_KNOWN_HOSTS_TARGET}:ro`);
  }

  // The Docker host's copy of the workspace is the project directory itself.
  const hostCwd = ssh.host_cwd ?? (dockerHost ? config.projectDir : undefined);
  if (hostCwd) env.SSH_HOST_CWD = hostCwd;

  if (ssh.host_path) env.SSH_HOST_PATH = ssh.host_path;
  if (ssh.login_shell ?? !ssh.host_path) env.SSH_LOGIN_SHELL = "1";
  if (ssh.env_passthrough?.length) env.SSH_ENV_PASSTHROUGH = ssh.env_passthrough.join(" ");
  if (ssh.connect_timeout !== undefined) env.SSH_CONNECT_TIMEOUT = String(ssh.connect_timeout);
  if (ssh.control_persist !== undefined) env.SSH_CONTROL_PERSIST = String(ssh.control_persist);
  if (ssh.max_sessions !== undefined) env.SSH_MAX_SESSIONS = String(ssh.max_sessions);
  if (ssh.probe === false) env.SSH_PROBE = "0";
  if (ssh.tty) env.SSH_TTY = "1";
  if (ssh.host_run === false) env.SSH_HOST_RUN = "0";

  // Docker Desktop resolves host.docker.internal by itself; Linux engines only
  // with an explicit host-gateway entry. Adding it everywhere is harmless.
  if (env.SSH_HOST === DOCKER_HOST_NAME) {
    extraHosts.push(`${DOCKER_HOST_NAME}:host-gateway`);
  }

  if (clientFiles) {
    binds.push(`${clientFiles.sshExec}:${SSH_EXEC_TARGET}:ro`);
    binds.push(`${clientFiles.entrypoint}:${ENTRYPOINT_TARGET}:ro`);
  }

  return { env, binds, extraHosts };
}

/**
 * Write the embedded ssh-exec and entrypoint to ~/.heretic/entrypoints/ and
 * return their paths. Kept out of the session dir: Docker Desktop (virtiofs)
 * mis-resolves file binds from a directory that is itself bind-mounted.
 */
export function writeSshClientFiles(): { sshExec: string; entrypoint: string } {
  const dir = join(homedir(), ".heretic", "entrypoints");
  mkdirSync(dir, { recursive: true });
  const sshExec = join(dir, "ssh-exec");
  const entrypoint = join(dir, "entrypoint.sh");
  writeFileSync(sshExec, SSH_EXEC_SCRIPT);
  chmodSync(sshExec, 0o755);
  writeFileSync(entrypoint, generateEntrypoint());
  chmodSync(entrypoint, 0o755);
  return { sshExec, entrypoint };
}

/**
 * Copy the private key to ~/.heretic/ssh/run/<profile>.key (dir 0700, file
 * 0644) for mounting. A 0600 key owned by the host uid (often not 1000 on
 * Linux) is unreadable for the container's agent user; the 0700 directory
 * keeps the copy private on the host, and ssh-exec re-copies it to a 0600
 * file inside the container.
 */
export function stageSshKey(keyPath: string, profileName: string): string {
  if (process.platform === "win32") return keyPath;
  const dir = join(homedir(), ".heretic", "ssh", "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const staged = join(dir, `${profileName}.key`);
  copyFileSync(keyPath, staged);
  chmodSync(staged, 0o644);
  return staged;
}

/** Container target of a "<source>:<target>[:ro|:rw]" bind (sources may contain "C:"). */
export function bindTarget(bind: string): string {
  const spec = bind.replace(/:(ro|rw)$/, "");
  return spec.slice(spec.lastIndexOf(":") + 1);
}

/** Append binds, skipping any whose container target is already mounted. */
export function appendBinds(binds: string[], extra: string[]): void {
  const targets = new Set(binds.map(bindTarget));
  for (const bind of extra) {
    const target = bindTarget(bind);
    if (!targets.has(target)) {
      targets.add(target);
      binds.push(bind);
    }
  }
}

/** Full wiring for a run: writes the client files when they are to be mounted. */
export function prepareSshBackend(config: ResolvedAgentConfig): SshBackendSpec | undefined {
  if (!config.ssh) return undefined;
  const clientFiles = config.ssh.mount_client === false ? undefined : writeSshClientFiles();
  const keyPath = config.ssh.key_path;
  const staged = keyPath && existsSync(keyPath) ? stageSshKey(keyPath, config.name) : undefined;
  return buildSshBackendSpec(config, clientFiles, staged);
}
