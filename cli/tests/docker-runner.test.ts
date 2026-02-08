/**
 * Docker Runner Tests
 *
 * Tests for the DockerRunner implementation
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DockerRunner } from "../src/runners/docker-runner";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";

describe("DockerRunner", () => {
  let tempProjectDir: string;
  let mockConfig: ResolvedAgentConfig;

  beforeEach(() => {
    tempProjectDir = mkdtempSync(join(tmpdir(), "heretic-docker-test-"));
    mockConfig = {
      name: "test-agent",
      image: "ubuntu:latest",
      runner: "docker",
      agentType: "claude",
      provider: "anthropic",
      projectDir: tempProjectDir,
      sessionName: "default",
      volumes: [
        {
          source: tempProjectDir,
          target: "/workspace",
          readonly: false,
        },
      ],
      env: {
        TEST_VAR: "test-value",
      },
      workdir: "/workspace",
      command: ["/bin/bash"],
      tty: true,
      interactive: true,
      extra: {
        network: "host",
        memory: "4g",
        cpus: "2.0",
      },
      dind: false,
      mcpOverride: false,
    };
  });

  afterEach(() => {
    if (tempProjectDir && existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });

  test("constructor initializes with config", () => {
    const runner = new DockerRunner(mockConfig);
    expect(runner).toBeDefined();
    expect(runner.getContainerId()).toBeUndefined();
  });

  test("getContainerId returns undefined when no container started", () => {
    const runner = new DockerRunner(mockConfig);
    expect(runner.getContainerId()).toBeUndefined();
  });

  test("isRunning returns false when no container exists", async () => {
    const runner = new DockerRunner(mockConfig);
    const running = await runner.isRunning();
    expect(running).toBe(false);
  });

  test("parseMemory handles various formats", () => {
    const runner = new DockerRunner(mockConfig);
    // Access private method via type assertion for testing
    const parseMemory = (runner as any).parseMemory.bind(runner);

    expect(parseMemory("1024b")).toBe(1024);
    expect(parseMemory("1k")).toBe(1024);
    expect(parseMemory("1m")).toBe(1024 * 1024);
    expect(parseMemory("4g")).toBe(4 * 1024 * 1024 * 1024);
  });

  test("parseCpus converts to nanoseconds", () => {
    const runner = new DockerRunner(mockConfig);
    const parseCpus = (runner as any).parseCpus.bind(runner);

    expect(parseCpus("2.0")).toBe(2e9);
    expect(parseCpus(2)).toBe(2e9);
    expect(parseCpus("0.5")).toBe(5e8);
  });

  test("translatePorts handles various port formats", () => {
    const runner = new DockerRunner(mockConfig);
    const translatePorts = (runner as any).translatePorts.bind(runner);

    const result = translatePorts(["8080", "3000:80"]);
    expect(result["8080/tcp"]).toEqual([{ HostPort: "8080" }]);
    expect(result["80/tcp"]).toEqual([{ HostPort: "3000" }]);
  });

  test("generateContainerName follows pattern with session", () => {
    const runner = new DockerRunner(mockConfig);
    const generateName = (runner as any).generateContainerName.bind(runner);

    const name = generateName();
    expect(name).toMatch(/^heretic-test-agent-default-[a-f0-9]{8}$/);
  });

  test("generateContainerName includes custom session name", () => {
    const runner = new DockerRunner({ ...mockConfig, sessionName: "feature-x" });
    const generateName = (runner as any).generateContainerName.bind(runner);

    const name = generateName();
    expect(name).toMatch(/^heretic-test-agent-feature-x-[a-f0-9]{8}$/);
  });

  test("translateConfig converts ResolvedAgentConfig correctly", () => {
    const runner = new DockerRunner(mockConfig);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();

    expect(options.Image).toBe("ubuntu:latest");
    expect(options.WorkingDir).toBe("/workspace");
    expect(options.Cmd).toEqual(["/bin/bash"]);
    expect(options.Env).toContain("TEST_VAR=test-value");
    expect(options.OpenStdin).toBe(true);
    expect(options.Tty).toBe(true);
    expect(options.Labels).toEqual({
      "heretic.managed": "true",
      "heretic.agent": "test-agent",
      "heretic.project": tempProjectDir,
      "heretic.session": "default",
    });
    expect(options.HostConfig?.Binds).toContain(`${tempProjectDir}:/workspace`);
    expect(options.HostConfig?.NetworkMode).toBe("host");
    expect(options.HostConfig?.Memory).toBe(4 * 1024 * 1024 * 1024);
    expect(options.HostConfig?.NanoCpus).toBe(2e9);
  });

  test("translateConfig handles command override", () => {
    const runner = new DockerRunner(mockConfig);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig(["echo", "hello"]);
    expect(options.Cmd).toEqual(["echo", "hello"]);
  });

  test("translateConfig handles readonly volumes", () => {
    const configWithRo: ResolvedAgentConfig = {
      ...mockConfig,
      volumes: [
        {
          source: "/test/readonly",
          target: "/readonly",
          readonly: true,
        },
      ],
    };

    const runner = new DockerRunner(configWithRo);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.HostConfig?.Binds).toContain("/test/readonly:/readonly:ro");
  });

  test("translateConfig handles ports", () => {
    const configWithPorts: ResolvedAgentConfig = {
      ...mockConfig,
      extra: {
        ports: ["8080:80", "3000"],
      },
    };

    const runner = new DockerRunner(configWithPorts);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.HostConfig?.PortBindings).toEqual({
      "80/tcp": [{ HostPort: "8080" }],
      "3000/tcp": [{ HostPort: "3000" }],
    });
  });

  test("translateConfig handles capabilities and privileged", () => {
    const configWithCaps: ResolvedAgentConfig = {
      ...mockConfig,
      extra: {
        capabilities: ["SYS_ADMIN", "NET_ADMIN"],
        privileged: true,
      },
    };

    const runner = new DockerRunner(configWithCaps);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.HostConfig?.CapAdd).toEqual(["SYS_ADMIN", "NET_ADMIN"]);
    expect(options.HostConfig?.Privileged).toBe(true);
  });

  test("translateConfig adds SSH env vars and key bind", () => {
    const configWithSsh: ResolvedAgentConfig = {
      ...mockConfig,
      ssh: {
        host: "dev-server.example.com",
        port: 2222,
        user: "myuser",
        key_path: "/home/user/.ssh/id_ed25519",
        host_cwd: "/remote/workspace",
      },
    };

    const runner = new DockerRunner(configWithSsh);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.Env).toContain("SSH_HOST=dev-server.example.com");
    expect(options.Env).toContain("SSH_PORT=2222");
    expect(options.Env).toContain("SSH_USER=myuser");
    expect(options.Env).toContain("SSH_KEY_PATH=/home/user/.ssh/id_ed25519");
    expect(options.Env).toContain("SSH_HOST_CWD=/remote/workspace");
    expect(options.HostConfig?.Binds).toContain(
      "/home/user/.ssh/id_ed25519:/home/agent/.ssh/id_rsa:ro"
    );
  });

  test("translateConfig uses SSH defaults for port and user", () => {
    const configWithSsh: ResolvedAgentConfig = {
      ...mockConfig,
      ssh: {
        host: "example.com",
      },
    };

    const runner = new DockerRunner(configWithSsh);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.Env).toContain("SSH_HOST=example.com");
    expect(options.Env).toContain("SSH_PORT=22");
    expect(options.Env).toContain("SSH_USER=agent");
  });

  test("translateConfig adds Git env vars", () => {
    const configWithGit: ResolvedAgentConfig = {
      ...mockConfig,
      git: {
        token: "ghp_test123",
        author_name: "Test Author",
        author_email: "test@example.com",
      },
    };

    const runner = new DockerRunner(configWithGit);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.Env).toContain("GH_TOKEN=ghp_test123");
    expect(options.Env).toContain("GIT_AUTHOR_NAME=Test Author");
    expect(options.Env).toContain("GIT_AUTHOR_EMAIL=test@example.com");
  });

  test("translateConfig adds docker.sock bind for dind", () => {
    const configWithDind: ResolvedAgentConfig = {
      ...mockConfig,
      dind: true,
    };

    const runner = new DockerRunner(configWithDind);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    // Check that some docker socket path is bound to /var/run/docker.sock inside the container
    const dockerSockBind = options.HostConfig?.Binds?.find((b: string) =>
      b.endsWith(":/var/run/docker.sock")
    );
    expect(dockerSockBind).toBeDefined();
  });

  test("translateConfig does not add docker.sock when dind is false", () => {
    const runner = new DockerRunner(mockConfig);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    const dockerSockBind = options.HostConfig?.Binds?.find((b: string) =>
      b.endsWith(":/var/run/docker.sock")
    );
    expect(dockerSockBind).toBeUndefined();
  });

  test("translateConfig handles custom labels", () => {
    const configWithLabels: ResolvedAgentConfig = {
      ...mockConfig,
      extra: {
        labels: {
          "custom.label": "value",
        },
      },
    };

    const runner = new DockerRunner(configWithLabels);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    expect(options.Labels).toEqual({
      "heretic.managed": "true",
      "heretic.agent": "test-agent",
      "heretic.project": tempProjectDir,
      "heretic.session": "default",
      "custom.label": "value",
    });
  });

  test("translateConfig mounts session dir as ~/.claude for anthropic provider", () => {
    const runner = new DockerRunner(mockConfig);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    const sessionDir = join(tempProjectDir, ".heretic", "temp", "default");
    const claudeBind = options.HostConfig?.Binds?.find((b: string) =>
      b.endsWith(":/home/agent/.claude")
    );
    expect(claudeBind).toBe(`${sessionDir}:/home/agent/.claude`);

    const rootClaudeBind = options.HostConfig?.Binds?.find((b: string) =>
      b.endsWith(":/root/.claude")
    );
    expect(rootClaudeBind).toBe(`${sessionDir}:/root/.claude`);
  });

  test("translateConfig mounts session dir as ~/.copilot for copilot provider", () => {
    const copilotConfig: ResolvedAgentConfig = {
      ...mockConfig,
      provider: "copilot",
      agentType: "copilot-cli",
    };

    const runner = new DockerRunner(copilotConfig);
    const translateConfig = (runner as any).translateConfig.bind(runner);

    const options = translateConfig();
    const sessionDir = join(tempProjectDir, ".heretic", "temp", "default");
    const copilotBind = options.HostConfig?.Binds?.find((b: string) =>
      b.endsWith(":/home/agent/.copilot")
    );
    expect(copilotBind).toBe(`${sessionDir}:/home/agent/.copilot`);

    // Should NOT have .claude mount
    const claudeBind = options.HostConfig?.Binds?.find((b: string) =>
      b.endsWith(":/home/agent/.claude")
    );
    expect(claudeBind).toBeUndefined();
  });

  describe("MCP config tests", () => {
    let tempProjectDir: string;

    afterEach(() => {
      // Cleanup temp directory if it exists
      if (tempProjectDir && existsSync(tempProjectDir)) {
        rmSync(tempProjectDir, { recursive: true, force: true });
      }
    });

    test("translateConfig uses agentType for MCP mount path", () => {
      tempProjectDir = mkdtempSync(join(tmpdir(), "heretic-test-"));

      const configWithMcp: ResolvedAgentConfig = {
        ...mockConfig,
        projectDir: tempProjectDir,
        agentType: "claude",
        mcp: [
          {
            name: "test-server",
            command: "npx",
            args: ["test-server"],
          },
        ],
        mcpOverride: true,
      };

      const runner = new DockerRunner(configWithMcp);
      const translateConfig = (runner as any).translateConfig.bind(runner);

      const options = translateConfig();
      // Check that MCP mount is to /workspace/.mcp.json for claude agent type
      const mcpBind = options.HostConfig?.Binds?.find((b: string) => b.includes(".mcp.json"));
      expect(mcpBind).toBeDefined();
      expect(mcpBind).toContain(":/workspace/.mcp.json");
    });

    test("translateConfig respects mcpOverride flag", () => {
      tempProjectDir = mkdtempSync(join(tmpdir(), "heretic-test-"));

      // When mcpOverride is true, MCP should be mounted even if .mcp.json exists
      const configWithMcpOverride: ResolvedAgentConfig = {
        ...mockConfig,
        projectDir: tempProjectDir,
        mcp: [
          {
            name: "test-server",
            command: "npx",
          },
        ],
        mcpOverride: true,
      };

      const runner = new DockerRunner(configWithMcpOverride);
      const translateConfig = (runner as any).translateConfig.bind(runner);

      const options = translateConfig();
      // With mcpOverride: true, MCP should always be mounted
      const mcpBind = options.HostConfig?.Binds?.find((b: string) => b.includes(".mcp.json"));
      expect(mcpBind).toBeDefined();
    });
  });
});
