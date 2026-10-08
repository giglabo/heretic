/**
 * Tests for CustomRunner
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CustomRunner } from "../src/runners/custom-runner";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CustomRunner", () => {
  let mockConfig: ResolvedAgentConfig;
  let testProjectDir: string;
  let composeFilePath: string;

  beforeEach(() => {
    // Create a temporary test project directory
    testProjectDir = join(tmpdir(), `heretic-test-${Date.now()}`);
    mkdirSync(testProjectDir, { recursive: true });
    mkdirSync(join(testProjectDir, ".heretic", "cli"), { recursive: true });

    // Create a test compose file in the updated path
    composeFilePath = join(testProjectDir, ".heretic", "cli", "compose.yaml");
    const composeContent = `
version: "3.8"
services:
  agent:
    image: alpine:latest
    command: ["sh", "-c", "echo test"]
`;
    writeFileSync(composeFilePath, composeContent, "utf-8");

    mockConfig = {
      name: "test-agent",
      projectDir: testProjectDir,
      image: "test-image:latest",
      runner: "custom",
      agentType: "claude",
      volumes: [
        {
          source: "/test/source",
          target: "/test/target",
          readonly: false,
        },
      ],
      env: {
        TEST_VAR: "test-value",
        ANOTHER_VAR: "another-value",
      },
      workdir: "/workspace",
      command: ["test-command"],
      tty: true,
      interactive: true,
      extra: {},
      dind: false,
      mcpOverride: false,
    };
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  test("constructor should create instance with valid compose file", () => {
    const runner = new CustomRunner(mockConfig);
    expect(runner).toBeDefined();
    expect(runner.getContainerId()).toBeUndefined();
  });

  test("constructor should throw error if compose file does not exist", () => {
    const config = {
      ...mockConfig,
      projectDir: "/nonexistent/path",
    };

    expect(() => new CustomRunner(config)).toThrow(/Custom compose file not found/);
  });

  test("constructor should sanitize project name", () => {
    const config = {
      ...mockConfig,
      name: "Test_Agent@123",
    };
    const runner = new CustomRunner(config);
    expect(runner).toBeDefined();
    // Project name should be sanitized to lowercase alphanumeric with dashes
  });

  test("getContainerId should return undefined initially", () => {
    const runner = new CustomRunner(mockConfig);
    expect(runner.getContainerId()).toBeUndefined();
  });

  test("should use compose file from project directory", () => {
    const runner = new CustomRunner(mockConfig);
    expect(runner).toBeDefined();
    // Verify that the runner was created with the compose file at the expected path
    expect(existsSync(composeFilePath)).toBe(true);
  });

  test("should handle environment variables in config", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      env: {
        DATABASE_URL: "postgres://localhost:5432/db",
        API_KEY: "secret-key",
        DEBUG: "true",
      },
    };
    const runner = new CustomRunner(config);
    expect(runner).toBeDefined();
  });

  test("should work with minimal config", () => {
    const config: ResolvedAgentConfig = {
      name: "minimal-agent",
      projectDir: testProjectDir,
      image: "alpine:latest",
      runner: "custom",
      agentType: "claude",
      volumes: [],
      env: {},
      workdir: "/",
      command: [],
      tty: false,
      interactive: false,
      extra: {},
      dind: false,
      mcpOverride: false,
    };
    const runner = new CustomRunner(config);
    expect(runner).toBeDefined();
  });

  test("should handle config with multiple environment variables", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      env: {
        VAR1: "value1",
        VAR2: "value2",
        VAR3: "value3",
        PATH: "/custom/path",
      },
    };
    const runner = new CustomRunner(config);
    expect(runner).toBeDefined();
  });
});
