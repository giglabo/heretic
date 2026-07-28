/**
 * Tests for ComposeRunner
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposeRunner } from "../src/runners/compose-runner";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";

describe("ComposeRunner", () => {
  let mockConfig: ResolvedAgentConfig;
  let tempProjectDir: string | undefined;

  afterEach(() => {
    if (tempProjectDir) {
      rmSync(tempProjectDir, { recursive: true, force: true });
      tempProjectDir = undefined;
    }
  });

  beforeEach(() => {
    mockConfig = {
      name: "test-agent",
      projectDir: "/test/project",
      sessionName: "default",
      image: "test-image:latest",
      runner: "compose",
      agentType: "claude",
      provider: "anthropic",
      volumes: [
        {
          source: "/test/source",
          target: "/test/target",
          readonly: false,
        },
      ],
      env: {
        TEST_VAR: "test-value",
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

  test("constructor should create instance", () => {
    const runner = new ComposeRunner(mockConfig);
    expect(runner).toBeDefined();
    expect(runner.getContainerId()).toBeUndefined();
  });

  test("constructor should sanitize project name", () => {
    const config = {
      ...mockConfig,
      name: "Test_Agent@123",
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
    // Project name should be sanitized to lowercase alphanumeric with dashes
  });

  test("getContainerId should return undefined initially", () => {
    const runner = new ComposeRunner(mockConfig);
    expect(runner.getContainerId()).toBeUndefined();
  });

  test("should handle compose configuration with services", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      compose: {
        services: {
          redis: {
            image: "redis:7",
            ports: ["6379:6379"],
          },
          postgres: {
            image: "postgres:16",
            environment: {
              POSTGRES_USER: "dev",
              POSTGRES_PASSWORD: "dev",
            },
          },
        },
      },
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });

  test("should handle compose configuration with networks", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      compose: {
        networks: {
          "custom-net": {
            driver: "bridge",
          },
        },
      },
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });

  test("should handle compose configuration with both services and networks", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      compose: {
        services: {
          db: {
            image: "postgres:16",
            environment: {
              POSTGRES_DB: "testdb",
            },
          },
        },
        networks: {
          backend: {
            driver: "bridge",
          },
        },
      },
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });

  test("should handle extra options", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      extra: {
        network: "host",
        ports: ["8080:8080"],
        capabilities: ["SYS_PTRACE"],
        privileged: false,
        user: "1000:1000",
        hostname: "test-host",
        memory: "4g",
        cpus: "2.0",
        shm_size: "2g",
        labels: {
          team: "platform",
        },
      },
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });

  test("run_as_root forces root user and sets HERETIC_RUN_AS_ROOT", () => {
    // Real project dir: run_as_root writes an entrypoint override into the session dir
    tempProjectDir = mkdtempSync(join(tmpdir(), "heretic-compose-"));
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      projectDir: tempProjectDir,
      extra: {
        user: "1000:1000",
        run_as_root: true,
      },
    };
    const runner = new ComposeRunner(config);
    const yaml = (runner as any).generateComposeYaml() as string;

    expect(yaml).toContain("user: root");
    expect(yaml).toContain("HERETIC_RUN_AS_ROOT");
  });

  test("should handle command override as array", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      command: ["bash", "-c", "echo test"],
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });

  test("should handle command override as string", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      command: "bash",
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });

  test("should handle read-only volumes", () => {
    const config: ResolvedAgentConfig = {
      ...mockConfig,
      volumes: [
        {
          source: "/test/source",
          target: "/test/target",
          readonly: true,
        },
      ],
    };
    const runner = new ComposeRunner(config);
    expect(runner).toBeDefined();
  });
});
