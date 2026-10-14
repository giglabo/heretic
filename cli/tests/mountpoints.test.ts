/**
 * Nested bind mountpoint tests
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindSource, ensureNestedMountpoints } from "../src/runners/mountpoints";

describe("bindSource", () => {
  test("strips the target and mode", () => {
    expect(bindSource("/a/b:/workspace")).toBe("/a/b");
    expect(bindSource("/a/b:/workspace:ro")).toBe("/a/b");
    expect(bindSource("C:\\Users\\me\\proj:/workspace:rw")).toBe("C:\\Users\\me\\proj");
  });
});

describe("ensureNestedMountpoints", () => {
  let root: string;
  let project: string;
  let mcpFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "heretic-mountpoints-"));
    project = join(root, "project");
    mkdirSync(project);
    mcpFile = join(root, "session", ".mcp.json");
    mkdirSync(join(root, "session"));
    writeFileSync(mcpFile, '{"mcpServers":{}}');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("creates an empty placeholder for a file bind inside a directory bind", () => {
    const created = ensureNestedMountpoints([
      `${project}:/workspace`,
      `${mcpFile}:/workspace/.mcp.json`,
    ]);
    expect(created).toEqual([join(project, ".mcp.json")]);
    expect(readFileSync(join(project, ".mcp.json"), "utf-8")).toBe("");
  });

  test("leaves an existing file untouched", () => {
    writeFileSync(join(project, ".mcp.json"), "keep");
    const created = ensureNestedMountpoints([
      `${project}:/workspace`,
      `${mcpFile}:/workspace/.mcp.json`,
    ]);
    expect(created).toEqual([]);
    expect(readFileSync(join(project, ".mcp.json"), "utf-8")).toBe("keep");
  });

  test("uses the innermost parent and creates missing directories", () => {
    const inner = join(root, "inner");
    mkdirSync(inner);
    const created = ensureNestedMountpoints([
      `${project}:/workspace:ro`,
      `${inner}:/workspace/sub/`,
      `${mcpFile}:/workspace/sub/deep/x.json:ro`,
    ]);
    expect(created).toEqual([join(inner, "deep", "x.json")]);
    expect(existsSync(join(project, "sub"))).toBe(false);
  });

  test("ignores binds that are not nested, directory binds and named volumes", () => {
    const created = ensureNestedMountpoints([
      `${project}:/workspace`,
      `${mcpFile}:/home/agent/.mcp.json`,
      `${join(root, "session")}:/workspace/session`,
      `heretic-cache:/workspace/cache`,
      `${join(root, "missing.json")}:/workspace/missing.json`,
    ]);
    expect(created).toEqual([]);
    expect(existsSync(join(project, "session"))).toBe(false);
    expect(existsSync(join(project, "missing.json"))).toBe(false);
  });
});
