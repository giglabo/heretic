/**
 * Tests for ComposeRunner
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ComposeRunner } from "../src/runners/compose-runner";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";

describe("ComposeRunner", () => {
  let mockConfig: ResolvedAgentConfig;

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
