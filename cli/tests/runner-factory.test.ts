/**
 * Runner Factory Tests
 *
 * Tests for the createRunner factory function that selects the correct runner
 * based on the resolved config's runner field.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createRunner, DockerRunner, ComposeRunner, CustomRunner } from "../src/runners";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const baseConfig: Omit<ResolvedAgentConfig, "runner"> = {
  name: "test-agent",
  projectDir: "/tmp/test-project",
  image: "test:latest",
  agentType: "claude",
  provider: "anthropic",
  volumes: [],
  env: {},
  workdir: "/app",
  command: ["bash"],
  tty: true,
  interactive: true,
  extra: {},
  compose: {},
  mcpOverride: false,
  dind: false,
  sessionName: "default",
};

describe("createRunner", () => {
  const testProjectDir = "/tmp/heretic-test-runner-factory";
  const composeFilePath = join(testProjectDir, ".heretic", "cli", "compose.yaml");

  beforeAll(() => {
    // Create test project directory with compose file for CustomRunner tests
    mkdirSync(join(testProjectDir, ".heretic", "cli"), { recursive: true });
    writeFileSync(composeFilePath, "version: '3'\nservices:\n  main:\n    image: test:latest\n");
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  it("should create DockerRunner when runner is 'docker'", () => {
    const config: ResolvedAgentConfig = {
      ...baseConfig,
      runner: "docker",
    };

    const runner = createRunner(config);
    expect(runner).toBeInstanceOf(DockerRunner);
  });

  it("should create ComposeRunner when runner is 'compose'", () => {
    const config: ResolvedAgentConfig = {
      ...baseConfig,
      runner: "compose",
    };

    const runner = createRunner(config);
    expect(runner).toBeInstanceOf(ComposeRunner);
  });

  it("should create CustomRunner when runner is 'custom'", () => {
    const config: ResolvedAgentConfig = {
      ...baseConfig,
      projectDir: testProjectDir,
      runner: "custom",
    };

    const runner = createRunner(config);
    expect(runner).toBeInstanceOf(CustomRunner);
  });

  it("should throw descriptive error for invalid runner type", () => {
    const config = {
      ...baseConfig,
      runner: "invalid" as any,
    };

    expect(() => createRunner(config)).toThrow(
      "Unknown runner type 'invalid'. Valid types: docker, compose, custom"
    );
  });

  it("should throw descriptive error for undefined runner type", () => {
    const config = {
      ...baseConfig,
      runner: undefined as any,
    };

    expect(() => createRunner(config)).toThrow(
      "Unknown runner type 'undefined'. Valid types: docker, compose, custom"
    );
  });
});
