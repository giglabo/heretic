/**
 * Tests for `heretic agents mcp` subcommand logic
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { loadProfile, saveProfile } from "../src/utils/profile-loader";
import {
  loadLocalConfig,
  saveLocalConfig,
  getLocalConfigPath,
  hasLocalConfig,
} from "../src/utils/local-config";
import { parseMcpJson } from "../src/runners/mcp-helper";
import type { AgentProfile, McpServer, LocalOverride } from "../src/types/agent-profile";
import { createTestContext } from "./test-helpers";

describe("agents mcp - merge logic", () => {
  const ctx = createTestContext("agents-mcp");

  beforeEach(() => {
    ctx.setup();
  });

  afterEach(() => {
    ctx.teardown();
  });

  test("should merge new servers into existing profile by name", () => {
    const profile: AgentProfile = {
      image: "test:latest",
      runner: "docker",
      mcp: [
        { name: "existing-server", command: "npx", args: ["-y", "existing"] },
        { name: "shared-server", command: "npx", args: ["-y", "old-version"] },
      ],
    };

    saveProfile("test-agent", profile);

    // Simulate merge logic
    const newServers: McpServer[] = [
      { name: "shared-server", command: "npx", args: ["-y", "new-version"] },
      { name: "brand-new", command: "node", args: ["server.js"] },
    ];

    const loaded = loadProfile("test-agent");
    const existingMcp = loaded.mcp || [];

    const serverMap = new Map<string, McpServer>();
    for (const s of existingMcp) serverMap.set(s.name, s);
    for (const s of newServers) serverMap.set(s.name, s);
    const merged = [...serverMap.values()];

    loaded.mcp = merged;
    saveProfile("test-agent", loaded);

    // Verify
    const updated = loadProfile("test-agent");
    expect(updated.mcp).toHaveLength(3);
    expect(updated.mcp![0].name).toBe("existing-server");
    expect(updated.mcp![1].name).toBe("shared-server");
    expect(updated.mcp![1].args).toEqual(["-y", "new-version"]);
    expect(updated.mcp![2].name).toBe("brand-new");
  });

  test("should append new servers not in existing profile", () => {
    const profile: AgentProfile = {
      image: "test:latest",
      runner: "docker",
    };

    saveProfile("test-agent", profile);

    const newServers: McpServer[] = [
      { name: "server-a", command: "npx", args: ["-y", "a"] },
      { name: "server-b", command: "npx", args: ["-y", "b"] },
    ];

    const loaded = loadProfile("test-agent");
    const existingMcp = loaded.mcp || [];

    const serverMap = new Map<string, McpServer>();
    for (const s of existingMcp) serverMap.set(s.name, s);
    for (const s of newServers) serverMap.set(s.name, s);
    const merged = [...serverMap.values()];

    loaded.mcp = merged;
    saveProfile("test-agent", loaded);

    const updated = loadProfile("test-agent");
    expect(updated.mcp).toHaveLength(2);
    expect(updated.mcp![0].name).toBe("server-a");
    expect(updated.mcp![1].name).toBe("server-b");
  });

  test("should handle --file flag (parseMcpJson from file content)", () => {
    const fileContent = {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      },
    };

    const servers = parseMcpJson(fileContent, "test-file.json");
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("filesystem");
    expect(servers[0].command).toBe("npx");
  });

  test("should show error for non-existent profile", () => {
    expect(() => loadProfile("nonexistent-agent")).toThrow("Profile not found");
  });
});

describe("agents mcp - local config", () => {
  let projectDir: string;
  const ctx = createTestContext("agents-mcp-local");

  beforeEach(() => {
    ctx.setup();
    projectDir = mkdtempSync(join(tmpdir(), "heretic-mcp-local-test-"));
  });

  afterEach(() => {
    ctx.teardown();
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("should save to local config with --local flag", () => {
    // Create a profile first
    saveProfile("test-agent", {
      image: "test:latest",
      runner: "docker",
    });

    const newServers: McpServer[] = [
      { name: "local-server", command: "npx", args: ["-y", "local"] },
    ];

    // Simulate local mode
    const config: LocalOverride = { extends: "test-agent", mcp: newServers };
    saveLocalConfig(projectDir, config);

    // Verify
    expect(hasLocalConfig(projectDir)).toBe(true);
    const loaded = loadLocalConfig(projectDir);
    expect(loaded.extends).toBe("test-agent");
    expect(loaded.mcp).toHaveLength(1);
    expect(loaded.mcp![0].name).toBe("local-server");
  });

  test("should create new local config if none exists", () => {
    expect(hasLocalConfig(projectDir)).toBe(false);

    const newServers: McpServer[] = [{ name: "new-server", command: "node", args: ["server.js"] }];

    const config: LocalOverride = { extends: "my-profile", mcp: newServers };
    saveLocalConfig(projectDir, config);

    expect(hasLocalConfig(projectDir)).toBe(true);
    const loaded = loadLocalConfig(projectDir);
    expect(loaded.extends).toBe("my-profile");
    expect(loaded.mcp).toHaveLength(1);
  });

  test("should merge into existing local config", () => {
    // Create existing local config
    const existingConfig: LocalOverride = {
      extends: "test-agent",
      mcp: [
        { name: "old-server", command: "npx", args: ["-y", "old"] },
        { name: "shared", command: "npx", args: ["-y", "old-shared"] },
      ],
      env: { KEEP_ME: "yes" },
    };
    saveLocalConfig(projectDir, existingConfig);

    // New servers to merge
    const newServers: McpServer[] = [
      { name: "shared", command: "npx", args: ["-y", "new-shared"] },
      { name: "brand-new", command: "node", args: ["new.js"] },
    ];

    // Load existing, merge, save
    const config = loadLocalConfig(projectDir);
    const existingMcp = config.mcp || [];

    const serverMap = new Map<string, McpServer>();
    for (const s of existingMcp) serverMap.set(s.name, s);
    for (const s of newServers) serverMap.set(s.name, s);

    config.mcp = [...serverMap.values()];
    saveLocalConfig(projectDir, config);

    // Verify
    const loaded = loadLocalConfig(projectDir);
    expect(loaded.mcp).toHaveLength(3);
    expect(loaded.mcp![0].name).toBe("old-server");
    expect(loaded.mcp![1].name).toBe("shared");
    expect(loaded.mcp![1].args).toEqual(["-y", "new-shared"]);
    expect(loaded.mcp![2].name).toBe("brand-new");
    // Preserve other fields
    expect(loaded.env?.KEEP_ME).toBe("yes");
  });
});
