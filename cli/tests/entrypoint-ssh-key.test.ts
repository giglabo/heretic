/**
 * entrypoint.sh stage_ssh_key: a 0600 copy of the mounted SSH backend key for plain `ssh -i`
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateEntrypoint } from "../src/templates";

const runSuite = process.platform === "win32" ? describe.skip : describe;
const ENTRYPOINT = generateEntrypoint();

/** The function alone, as tests/e2e/ssh-e2e.sh extracts setup_tool_wrappers. */
const STAGE_FN = ENTRYPOINT.slice(
  ENTRYPOINT.indexOf("stage_ssh_key() {"),
  ENTRYPOINT.indexOf("\n}\n", ENTRYPOINT.indexOf("stage_ssh_key() {")) + 3
);

runSuite("stage_ssh_key", () => {
  let root: string;
  let key: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "heretic-stage-key-"));
    key = join(root, "key");
    writeFileSync(key, "PRIVATE\n");
    chmodSync(key, 0o644);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stage(env: Record<string, string>): { stdout: string; keyPath: string } {
    const res = spawnSync(
      "bash",
      ["-c", `set -e; ${STAGE_FN}\nstage_ssh_key\nprintf '%s' "$SSH_KEY_PATH" >&2`],
      { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }
    );
    expect(res.status).toBe(0);
    return { stdout: res.stdout, keyPath: res.stderr };
  }

  test("copies the key to a 0600 file and points SSH_KEY_PATH at it", () => {
    const rt = join(root, "rt");
    const r = stage({ SSH_HOST: "h", SSH_USER: "me", SSH_KEY_PATH: key, SSH_RUNTIME_DIR: rt });
    expect(r.keyPath).toBe(join(rt, "identity"));
    expect(statSync(r.keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.keyPath, "utf8")).toBe("PRIVATE\n");
    expect(r.stdout).toContain('ssh -i "$SSH_KEY_PATH" -p 22 me@h');
  });

  test("does nothing without the SSH backend or a readable key", () => {
    expect(stage({ SSH_KEY_PATH: key }).keyPath).toBe(key);
    const missing = join(root, "missing");
    expect(stage({ SSH_HOST: "h", SSH_KEY_PATH: missing }).keyPath).toBe(missing);
  });
});
