/**
 * Tests for ComposeRunner
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposeRunner } from "../src/runners/compose-runner";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";
import { parseYaml } from "../src/utils/yaml";

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

  test("projectName includes the project-dir hash", () => {
    const runner = new ComposeRunner(mockConfig);
    expect((runner as any).projectName).toMatch(/^heretic-test-agent-default-[a-f0-9]{8}$/);
  });

  test("same profile + session in two folders get different compose projects", () => {
    const a = new ComposeRunner({ ...mockConfig, projectDir: "/test/one" });
    const b = new ComposeRunner({ ...mockConfig, projectDir: "/test/two" });
    expect((a as any).projectName).not.toBe((b as any).projectName);
  });
});

describe("ComposeRunner build sidecars", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heretic-sidecar-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  const baseConfig = (): ResolvedAgentConfig => ({
    name: "test-agent",
    projectDir,
    sessionName: "default",
    image: "test-image:latest",
    runner: "compose",
    agentType: "claude",
    provider: "anthropic",
    volumes: [{ source: "/host/project", target: "/workspace", readonly: false }],
    env: {},
    workdir: "/workspace",
    command: [],
    tty: false,
    interactive: false,
    extra: {},
    dind: false,
    mcpOverride: false,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = (config: ResolvedAgentConfig): any => {
    const runner = new ComposeRunner(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return parseYaml((runner as any).generateComposeYaml());
  };

  test("emits a builder service sharing the workspace bind", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: { sidecars: [{ runtime: "node", image: "heretic-builder-node:latest" }] },
    });
    const builder = spec.services["builder-node"];
    expect(builder).toBeDefined();
    expect(builder.image).toBe("heretic-builder-node:latest");
    expect(builder.working_dir).toBe("/workspace");
    expect(builder.volumes).toContain("/host/project:/workspace");
    expect(builder.command).toEqual(["exec-server", "-port", "8080", "-cwd", "/workspace"]);
  });

  test("injects BUILD_SIDECARS into the agent in the normative shape", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: {
        sidecars: [
          { runtime: "node", image: "n:latest" },
          { runtime: "python", image: "p:latest", port: 9000 },
        ],
      },
    });
    const raw = spec.services.agent.environment.BUILD_SIDECARS;
    expect(JSON.parse(raw)).toEqual({
      node: { internal_url: "http://builder-node:8080" },
      python: { internal_url: "http://builder-python:9000" },
    });
  });

  test("gates the agent on each builder's health", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: { sidecars: [{ runtime: "node", image: "n:latest" }] },
    });
    expect(spec.services.agent.depends_on["builder-node"]).toEqual({
      condition: "service_healthy",
    });
    expect(spec.services["builder-node"].healthcheck).toBeDefined();
  });

  test("runs builders as the caller uid with a hardened posture (F-2, C-9)", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: { sidecars: [{ runtime: "node", image: "n:latest" }] },
    });
    const builder = spec.services["builder-node"];
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    expect(builder.user).toBe(`${uid}:${gid}`);
    expect(builder.cap_drop).toEqual(["ALL"]);
    expect(builder.security_opt).toContain("no-new-privileges:true");
    // builders must NOT publish ports (reachable only by service name)
    expect(builder.ports).toBeUndefined();
  });

  test("run_as_caller_uid: false omits the user override", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: {
        run_as_caller_uid: false,
        sidecars: [{ runtime: "node", image: "n:latest" }],
      },
    });
    expect(spec.services["builder-node"].user).toBeUndefined();
  });

  test("unions env_passthrough into SIDECAR_ENV_PASSTHROUGH", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: {
        sidecars: [
          { runtime: "node", image: "n:latest", env_passthrough: ["NPM_TOKEN"] },
          {
            runtime: "python",
            image: "p:latest",
            env_passthrough: ["PIP_INDEX_URL", "NPM_TOKEN"],
          },
        ],
      },
    });
    const passthrough = spec.services.agent.environment.SIDECAR_ENV_PASSTHROUGH.split(",");
    expect(passthrough).toContain("NPM_TOKEN");
    expect(passthrough).toContain("PIP_INDEX_URL");
  });

  test("declares named cache volumes at the top level (gap F-3)", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: {
        sidecars: [
          {
            runtime: "node",
            image: "n:latest",
            cache_volumes: ["heretic-cache-node:/home/agent/.npm"],
          },
        ],
      },
    });
    expect(spec.services["builder-node"].volumes).toContain("heretic-cache-node:/home/agent/.npm");
    expect("heretic-cache-node" in spec.volumes).toBe(true);
  });

  test("honors a custom workspace_target", () => {
    const spec = gen({
      ...baseConfig(),
      volumes: [{ source: "/host/code", target: "/code" }],
      workdir: "/code",
      toolBackends: {
        workspace_target: "/code",
        sidecars: [{ runtime: "go", image: "g:latest" }],
      },
    });
    expect(spec.services["builder-go"].working_dir).toBe("/code");
    expect(spec.services["builder-go"].volumes).toContain("/host/code:/code");
    expect(JSON.parse(spec.services.agent.environment.BUILD_SIDECARS).go.internal_url).toBe(
      "http://builder-go:8080"
    );
  });

  test("respects a command override on the sidecar", () => {
    const spec = gen({
      ...baseConfig(),
      toolBackends: {
        sidecars: [
          {
            runtime: "node",
            image: "n:latest",
            command: ["/usr/local/bin/serve", "--port", "8080"],
          },
        ],
      },
    });
    expect(spec.services["builder-node"].command).toEqual([
      "/usr/local/bin/serve",
      "--port",
      "8080",
    ]);
  });

  test("no sidecars → no builder services and no BUILD_SIDECARS", () => {
    const spec = gen(baseConfig());
    const builders = Object.keys(spec.services).filter((s: string) => s.startsWith("builder-"));
    expect(builders).toEqual([]);
    expect(spec.services.agent.environment?.BUILD_SIDECARS).toBeUndefined();
  });
});

describe("ComposeRunner SSH backend", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heretic-ssh-compose-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = (config: ResolvedAgentConfig): any => {
    const runner = new ComposeRunner(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return parseYaml((runner as any).generateComposeYaml());
  };

  const baseConfig = (): ResolvedAgentConfig => ({
    name: "test-agent",
    projectDir,
    sessionName: "default",
    image: "test-image:latest",
    runner: "compose",
    agentType: "claude",
    provider: "anthropic",
    volumes: [{ source: "/host/project", target: "/workspace", readonly: false }],
    env: {},
    workdir: "/workspace",
    command: [],
    tty: false,
    interactive: false,
    extra: {},
    dind: false,
    mcpOverride: false,
  });

  test("injects SSH_* env and mounts the key read-only", () => {
    const spec = gen({
      ...baseConfig(),
      ssh: {
        host: "build-host.internal",
        port: 2222,
        user: "builder",
        key_path: "/home/me/.ssh/id_build",
        host_cwd: "/srv/workspace",
      },
    });
    const agent = spec.services.agent;
    expect(agent.environment.SSH_HOST).toBe("build-host.internal");
    expect(agent.environment.SSH_PORT).toBe("2222");
    expect(agent.environment.SSH_USER).toBe("builder");
    expect(agent.environment.SSH_KEY_PATH).toBe("/home/me/.ssh/id_build");
    expect(agent.environment.SSH_HOST_CWD).toBe("/srv/workspace");
    expect(agent.volumes).toContain("/home/me/.ssh/id_build:/home/agent/.ssh/id_rsa:ro");
  });

  test("defaults port to 22 and user to agent, no key bind without key_path", () => {
    const spec = gen({ ...baseConfig(), ssh: { host: "h" } });
    const agent = spec.services.agent;
    expect(agent.environment.SSH_HOST).toBe("h");
    expect(agent.environment.SSH_PORT).toBe("22");
    expect(agent.environment.SSH_USER).toBe("agent");
    const keyBind = (agent.volumes || []).find((v: string) => v.includes("id_rsa"));
    expect(keyBind).toBeUndefined();
  });
});
