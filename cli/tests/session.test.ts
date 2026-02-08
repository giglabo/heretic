/**
 * Session Utility Tests
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSessionDir, ensureSessionDir, sanitizeSessionName } from "../src/utils/session";

describe("Session Utils", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("getSessionDir", () => {
    test("should return correct path for project and session", () => {
      const result = getSessionDir("/my/project", "default");
      expect(result).toBe(join("/my/project", ".heretic", "temp", "default"));
    });

    test("should handle custom session names", () => {
      const result = getSessionDir("/my/project", "feature-x");
      expect(result).toBe(join("/my/project", ".heretic", "temp", "feature-x"));
    });
  });

  describe("ensureSessionDir", () => {
    test("should create directory if it does not exist", () => {
      testDir = mkdtempSync(join(tmpdir(), "heretic-session-test-"));
      const sessionDir = ensureSessionDir(testDir, "test-session");

      expect(existsSync(sessionDir)).toBe(true);
      expect(sessionDir).toBe(join(testDir, ".heretic", "temp", "test-session"));
    });

    test("should return existing directory without error", () => {
      testDir = mkdtempSync(join(tmpdir(), "heretic-session-test-"));
      const sessionDir1 = ensureSessionDir(testDir, "test-session");
      const sessionDir2 = ensureSessionDir(testDir, "test-session");

      expect(sessionDir1).toBe(sessionDir2);
      expect(existsSync(sessionDir2)).toBe(true);
    });

    test("should create separate directories for different sessions", () => {
      testDir = mkdtempSync(join(tmpdir(), "heretic-session-test-"));
      const dir1 = ensureSessionDir(testDir, "session-a");
      const dir2 = ensureSessionDir(testDir, "session-b");

      expect(dir1).not.toBe(dir2);
      expect(existsSync(dir1)).toBe(true);
      expect(existsSync(dir2)).toBe(true);
    });
  });

  describe("sanitizeSessionName", () => {
    test("should pass through valid names unchanged", () => {
      expect(sanitizeSessionName("default")).toBe("default");
      expect(sanitizeSessionName("feature-x")).toBe("feature-x");
      expect(sanitizeSessionName("my_session")).toBe("my_session");
      expect(sanitizeSessionName("test123")).toBe("test123");
    });

    test("should replace invalid characters with dashes", () => {
      expect(sanitizeSessionName("my session")).toBe("my-session");
      expect(sanitizeSessionName("my/session")).toBe("my-session");
      expect(sanitizeSessionName("my@session!")).toBe("my-session-");
      expect(sanitizeSessionName("a.b.c")).toBe("a-b-c");
    });

    test("should handle empty string", () => {
      expect(sanitizeSessionName("")).toBe("");
    });
  });
});
