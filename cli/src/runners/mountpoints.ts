/**
 * Host-side mountpoints for binds nested inside other binds.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { getLogger } from "../logger";
import { bindTarget } from "./ssh-backend";

const logger = getLogger();

/** Host source of a "<source>:<target>[:ro|:rw]" bind (sources may contain "C:"). */
export function bindSource(bind: string): string {
  const spec = bind.replace(/:(ro|rw)$/, "");
  return spec.slice(0, spec.lastIndexOf(":"));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create the host-side mountpoint of every file bind that lands inside a directory
 * bind — e.g. the profile's MCP config at `/workspace/.mcp.json` inside
 * `<project>:/workspace`.
 *
 * Docker Desktop (virtiofs) cannot create such a mountpoint itself: the first run in a
 * folder without the file fails with "mountpoint ... is outside of rootfs", leaving the
 * empty file behind so only the next run works. Docker on Linux creates the same empty
 * file, so creating it up front only removes the failure. An empty `.mcp.json` is not a
 * usable MCP config (`hasUsableMcpConfig`), so it never suppresses the profile's mount.
 *
 * @param binds - Final "<source>:<target>[:ro|:rw]" binds of the container
 * @returns Host paths of the placeholders created
 */
export function ensureNestedMountpoints(binds: string[]): string[] {
  const parsed = binds
    .map((bind) => ({ source: bindSource(bind), target: posix.normalize(bindTarget(bind)) }))
    .filter((b) => isAbsolute(b.source) && existsSync(b.source)); // skips named volumes
  const dirs = parsed.filter((b) => isDirectory(b.source));

  const created: string[] = [];
  for (const file of parsed.filter((b) => !isDirectory(b.source))) {
    // Innermost directory bind that contains the file's target
    const parent = dirs
      .filter((d) => file.target.startsWith(d.target.replace(/\/$/, "") + "/"))
      .sort((a, b) => b.target.length - a.target.length)[0];
    if (!parent) continue;

    const hostPath = join(parent.source, posix.relative(parent.target, file.target));
    if (existsSync(hostPath)) continue;
    try {
      mkdirSync(dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, "", { flag: "wx" });
      created.push(hostPath);
      logger.debug({ hostPath, target: file.target }, "Created mountpoint for nested file bind");
    } catch (error) {
      logger.warn({ error, hostPath }, "Could not create mountpoint for nested file bind");
    }
  }
  return created;
}
