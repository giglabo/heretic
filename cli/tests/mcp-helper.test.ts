/**
 * MCP Helper Tests
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeMcpFile,
  cleanupMcpFile,
  loadMcpFromFile,
  parseMcpJson,
} from "../src/runners/mcp-helper";
import type { McpServer } from "../src/types/agent-profile";

describe("MCP Helper", () => {
  let testDir: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = mkdtempSync(join(tmpdir(), "heretic-mcp-test-"));
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("writeMcpFile", () => {
    test("should write valid JSON with correct structure", () => {
      const servers: McpServer[] = [
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        },
      ];

      const filepath = writeMcpFile(testDir, servers);

      expect(existsSync(filepath)).toBe(true);
      expect(filepath).toBe(join(testDir, ".heretic", "cli", "temp", ".mcp.json"));

      const content = JSON.parse(readFileSync(filepath, "utf-8"));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.filesystem).toEqual({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      });
    });

    test("should serialize multiple servers correctly", () => {
      const servers: McpServer[] = [
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
        {
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "test-token" },
        },
      ];

      const filepath = writeMcpFile(testDir, servers);
      const content = JSON.parse(readFileSync(filepath, "utf-8"));

      expect(Object.keys(content.mcpServers)).toEqual(["filesystem", "github"]);
      expect(content.mcpServers.github.env).toEqual({ GITHUB_TOKEN: "test-token" });
    });

    test("should omit empty args and env", () => {
      const servers: McpServer[] = [
        {
          name: "simple",
          command: "my-server",
        },
      ];

      const filepath = writeMcpFile(testDir, servers);
      const content = JSON.parse(readFileSync(filepath, "utf-8"));

      expect(content.mcpServers.simple).toEqual({ command: "my-server" });
      expect(content.mcpServers.simple.args).toBeUndefined();
      expect(content.mcpServers.simple.env).toBeUndefined();
    });

    test("should create .heretic/cli/temp/ directory if it does not exist", () => {
      const tempDir = join(testDir, ".heretic", "cli", "temp");
      expect(existsSync(tempDir)).toBe(false);

      writeMcpFile(testDir, [{ name: "test", command: "test" }]);

      expect(existsSync(tempDir)).toBe(true);
    });

    test("should write to sessionDir when provided", () => {
      const sessionDir = join(testDir, ".heretic", "temp", "my-session");
      mkdirSync(sessionDir, { recursive: true });

      const servers: McpServer[] = [{ name: "test-server", command: "npx", args: ["test"] }];

      const filepath = writeMcpFile(testDir, servers, sessionDir);

      expect(filepath).toBe(join(sessionDir, ".mcp.json"));
      expect(existsSync(filepath)).toBe(true);

      const content = JSON.parse(readFileSync(filepath, "utf-8"));
      expect(content.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["test"],
      });
    });

    test("should fallback to legacy path when sessionDir is not provided", () => {
      const servers: McpServer[] = [{ name: "test", command: "test" }];
      const filepath = writeMcpFile(testDir, servers);

      expect(filepath).toBe(join(testDir, ".heretic", "cli", "temp", ".mcp.json"));
    });
  });

  describe("cleanupMcpFile", () => {
    test("should remove file if it exists", () => {
      const filepath = writeMcpFile(testDir, [{ name: "test", command: "test" }]);
      expect(existsSync(filepath)).toBe(true);

      cleanupMcpFile(filepath);
      expect(existsSync(filepath)).toBe(false);
    });

    test("should not throw if file does not exist", () => {
      expect(() => cleanupMcpFile("/nonexistent/path/.mcp.json")).not.toThrow();
    });
  });

  describe("loadMcpFromFile", () => {
    test("should load mcpServers format (Claude/Copilot CLI)", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          mcpServers: {
            trello: {
              command: "npx",
              args: ["-y", "mcp-remote", "http://localhost:9090/sse"],
            },
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_TOKEN: "test-token" },
            },
          },
        })
      );

      const servers = loadMcpFromFile(filePath);

      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual({
        name: "trello",
        command: "npx",
        args: ["-y", "mcp-remote", "http://localhost:9090/sse"],
      });
      expect(servers[1]).toEqual({
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "test-token" },
      });
    });

    test("should load servers format (VS Code)", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          servers: {
            kanboard: {
              type: "stdio",
              command: "/usr/local/bin/kanboard-mcp",
              args: ["--config", "/etc/kanboard.json"],
            },
          },
        })
      );

      const servers = loadMcpFromFile(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "kanboard",
        command: "/usr/local/bin/kanboard-mcp",
        args: ["--config", "/etc/kanboard.json"],
      });
    });

    test("should load bare server map format", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          "my-server": {
            command: "node",
            args: ["server.js"],
          },
        })
      );

      const servers = loadMcpFromFile(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "my-server",
        command: "node",
        args: ["server.js"],
      });
    });

    test("should ignore extra fields like type, cwd", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          servers: {
            test: {
              type: "stdio",
              command: "npx",
              args: ["-y", "test-server"],
              cwd: "/some/path",
              env: { KEY: "val" },
            },
          },
        })
      );

      const servers = loadMcpFromFile(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "test",
        command: "npx",
        args: ["-y", "test-server"],
        env: { KEY: "val" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((servers[0] as any).type).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((servers[0] as any).cwd).toBeUndefined();
    });

    test("should throw if file does not exist", () => {
      expect(() => loadMcpFromFile("/nonexistent/mcp.json")).toThrow("MCP file not found");
    });

    test("should throw if file is not valid JSON", () => {
      const filePath = join(testDir, "bad.json");
      writeFileSync(filePath, "not json {{{");

      expect(() => loadMcpFromFile(filePath)).toThrow("Failed to parse MCP file as JSON");
    });

    test("should throw if file is not an object", () => {
      const filePath = join(testDir, "array.json");
      writeFileSync(filePath, JSON.stringify([1, 2, 3]));

      expect(() => loadMcpFromFile(filePath)).toThrow("must be a JSON object");
    });

    test("should throw if server entry is missing command", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          mcpServers: {
            broken: { args: ["-y", "test"] },
          },
        })
      );

      expect(() => loadMcpFromFile(filePath)).toThrow("missing required field 'command'");
    });

    test("should handle server with no args or env", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          mcpServers: {
            simple: { command: "my-server" },
          },
        })
      );

      const servers = loadMcpFromFile(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "simple",
        command: "my-server",
      });
      expect(servers[0].args).toBeUndefined();
      expect(servers[0].env).toBeUndefined();
    });

    test("should handle empty server map", () => {
      const filePath = join(testDir, "mcp.json");
      writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));

      const servers = loadMcpFromFile(filePath);
      expect(servers).toHaveLength(0);
    });
  });

  describe("parseMcpJson", () => {
    test("should parse mcpServers format", () => {
      const input = {
        mcpServers: {
          trello: {
            command: "npx",
            args: ["-y", "mcp-remote", "http://localhost:9090/sse"],
          },
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "test-token" },
          },
        },
      };

      const servers = parseMcpJson(input);

      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual({
        name: "trello",
        command: "npx",
        args: ["-y", "mcp-remote", "http://localhost:9090/sse"],
      });
      expect(servers[1]).toEqual({
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "test-token" },
      });
    });

    test("should parse servers format (VS Code)", () => {
      const input = {
        servers: {
          kanboard: {
            type: "stdio",
            command: "/usr/local/bin/kanboard-mcp",
            args: ["--config", "/etc/kanboard.json"],
          },
        },
      };

      const servers = parseMcpJson(input);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "kanboard",
        command: "/usr/local/bin/kanboard-mcp",
        args: ["--config", "/etc/kanboard.json"],
      });
    });

    test("should parse bare server map format", () => {
      const input = {
        "my-server": {
          command: "node",
          args: ["server.js"],
        },
      };

      const servers = parseMcpJson(input);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "my-server",
        command: "node",
        args: ["server.js"],
      });
    });

    test("should throw on non-object input", () => {
      expect(() => parseMcpJson("string")).toThrow("must be a JSON object");
      expect(() => parseMcpJson([1, 2])).toThrow("must be a JSON object");
      expect(() => parseMcpJson(null)).toThrow("must be a JSON object");
    });

    test("should throw on missing command", () => {
      const input = {
        mcpServers: {
          broken: { args: ["-y", "test"] },
        },
      };

      expect(() => parseMcpJson(input)).toThrow("missing required field 'command'");
    });

    test("should ignore extra fields like type and cwd", () => {
      const input = {
        servers: {
          test: {
            type: "stdio",
            command: "npx",
            args: ["-y", "test-server"],
            cwd: "/some/path",
            env: { KEY: "val" },
          },
        },
      };

      const servers = parseMcpJson(input);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        name: "test",
        command: "npx",
        args: ["-y", "test-server"],
        env: { KEY: "val" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((servers[0] as any).type).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((servers[0] as any).cwd).toBeUndefined();
    });

    test("should use source label in error messages", () => {
      expect(() => parseMcpJson("bad", "my-file.json")).toThrow(
        "MCP my-file.json must be a JSON object"
      );
    });

    test("should handle empty server map", () => {
      const servers = parseMcpJson({ mcpServers: {} });
      expect(servers).toHaveLength(0);
    });
  });
});
