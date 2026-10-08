/**
 * Pure helpers behind `heretic-cli ssh setup|check`: authorized_keys and
 * known_hosts lines, host PATH capture parsing, toolchain detection and
 * preset selection. No I/O here — the command module does the side effects.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SshPreset } from "../types/agent-profile";
import { SSH_PRESET_NAMES, SSH_PRESETS } from "./ssh-presets";

/** Marker around the PATH printed by the host login shell (banners/motd are ignored). */
export const PATH_MARKER = "__HERETIC_PATH__";

/** Shell snippet that prints the login-shell PATH between markers. */
export const PATH_CAPTURE_SCRIPT = `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`;

/** Extract the PATH printed with PATH_CAPTURE_SCRIPT from noisy shell output. */
export function parseCapturedPath(output: string): string | undefined {
  const start = output.indexOf(PATH_MARKER);
  if (start < 0) return undefined;
  const end = output.indexOf(PATH_MARKER, start + PATH_MARKER.length);
  if (end < 0) return undefined;
  const path = output.slice(start + PATH_MARKER.length, end).trim();
  return path || undefined;
}

/**
 * authorized_keys line for a heretic key. `restrict` turns off port, agent and
 * X11 forwarding; `pty` is re-allowed for `ssh.tty: true`. `from` limits the
 * source addresses when given.
 */
export function buildAuthorizedKeysLine(publicKey: string, comment: string, from?: string): string {
  const [type, body] = publicKey.trim().split(/\s+/);
  const options = ["restrict", "pty"];
  if (from) options.push(`from="${from}"`);
  return `${options.join(",")} ${type} ${body} ${comment}`;
}

/** True when `existing` (authorized_keys content) already holds this key. */
export function hasAuthorizedKey(existing: string, publicKey: string): boolean {
  const body = publicKey.trim().split(/\s+/)[1];
  if (!body) return false;
  return existing.split("\n").some((line) => line.split(/\s+/).includes(body));
}

/** known_hosts host pattern: `name` on port 22, `[name]:port` otherwise. */
export function knownHostsPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * known_hosts lines pinning the given host public keys (contents of
 * /etc/ssh/ssh_host_*_key.pub or ssh-keyscan output) under `host`.
 */
export function buildKnownHostsLines(host: string, port: number, hostKeys: string[]): string[] {
  const pattern = knownHostsPattern(host, port);
  const lines: string[] = [];
  for (const raw of hostKeys) {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      // keyscan format: "<host> <type> <key>"; .pub format: "<type> <key> [comment]"
      const [type, key] =
        parts[0].startsWith("ssh-") || parts[0].startsWith("ecdsa-")
          ? [parts[0], parts[1]]
          : [parts[1], parts[2]];
      if (type && key) lines.push(`${pattern} ${type} ${key}`);
    }
  }
  return [...new Set(lines)];
}

/** True when `file` is an executable regular file. */
function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Commands from `names` found as executables on `pathValue` (local host only). */
export function findCommandsOnPath(names: readonly string[], pathValue: string): string[] {
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return names.filter((name) =>
    dirs.some((dir) => exts.some((ext) => isExecutable(join(dir, name + ext))))
  );
}

export interface PresetDetection {
  preset: SshPreset;
  found: string[];
  missing: string[];
}

/** Per-preset found/missing split for a set of host commands. */
export function detectPresets(available: readonly string[]): PresetDetection[] {
  const have = new Set(available);
  return SSH_PRESET_NAMES.map((preset) => {
    const cmds = SSH_PRESETS[preset];
    return {
      preset,
      found: cmds.filter((c) => have.has(c)),
      missing: cmds.filter((c) => !have.has(c)),
    };
  });
}

/**
 * Presets to enable automatically: toolchain presets with at least one command
 * on the host. `container` (root-equivalent) and `vcs` (the container has git)
 * are never auto-enabled — the user opts in explicitly.
 */
export function selectPresets(detections: readonly PresetDetection[]): SshPreset[] {
  const optIn: SshPreset[] = ["container", "vcs"];
  return detections
    .filter((d) => d.found.length > 0 && !optIn.includes(d.preset))
    .map((d) => d.preset);
}

/**
 * macOS privacy (TCC) blocks sshd sessions from ~/Documents, ~/Desktop and
 * ~/Downloads unless sshd has Full Disk Access. Returns the protected folder
 * that contains `dir`, if any.
 */
export function macProtectedFolder(dir: string, home: string): string | undefined {
  for (const name of ["Documents", "Desktop", "Downloads"]) {
    const protectedDir = join(home, name);
    if (dir === protectedDir || dir.startsWith(protectedDir + "/")) return protectedDir;
  }
  return undefined;
}
