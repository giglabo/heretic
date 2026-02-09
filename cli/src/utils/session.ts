import { join } from "node:path";
import { mkdirSync, chmodSync, existsSync } from "node:fs";

/**
 * Get the session directory path for a given project and session name.
 *
 * @param projectDir - Absolute path to the project directory
 * @param sessionName - Session name (already sanitized)
 * @returns Absolute path to the session directory
 */
export function getSessionDir(projectDir: string, sessionName: string): string {
  return join(projectDir, ".heretic", "temp", sessionName);
}

/**
 * Ensure the session directory exists, creating it if necessary.
 *
 * @param projectDir - Absolute path to the project directory
 * @param sessionName - Session name (already sanitized)
 * @returns Absolute path to the created/existing session directory
 */
export function ensureSessionDir(projectDir: string, sessionName: string): string {
  const dir = getSessionDir(projectDir, sessionName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    // Ensure the leaf directory is world-writable so container users
    // (which may have a different UID) can write to the mounted volume.
    chmodSync(dir, 0o777);
  }
  return dir;
}

/**
 * Sanitize a session name to only contain safe characters.
 *
 * @param name - Raw session name from user input
 * @returns Sanitized session name safe for use in paths and container names
 */
export function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}
