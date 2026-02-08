import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { AgentProfile, LocalOverride, ResolvedAgentConfig } from "../src/types/agent-profile";
import * as profileLoader from "../src/utils/profile-loader";
import * as localConfig from "../src/utils/local-config";
import * as mcpHelper from "../src/runners/mcp-helper";
import { resolveConfig, validateResolvedConfig } from "../src/utils/config-resolver";

// Use spyOn instead of mock.module to avoid globally replacing modules
// (mock.module contaminates other test files running in parallel)
let mockLoadProfile: ReturnType<typeof spyOn>;
let mockHasLocalConfig: ReturnType<typeof spyOn>;
let mockLoadLocalConfig: ReturnType<typeof spyOn>;
let mockLoadMcpFromFile: ReturnType<typeof spyOn>;

describe("Config Resolver", () => {
  beforeEach(() => {
    mockLoadProfile = spyOn(profileLoader, "loadProfile");
    mockHasLocalConfig = spyOn(localConfig, "hasLocalConfig").mockReturnValue(false);
    mockLoadLocalConfig = spyOn(localConfig, "loadLocalConfig");
    mockLoadMcpFromFile = spyOn(mcpHelper, "loadMcpFromFile").mockReturnValue([]);
  });

  afterEach(() => {
    mockLoadProfile.mockRestore();
    mockHasLocalConfig.mockRestore();
    mockLoadLocalConfig.mockRestore();
    mockLoadMcpFromFile.mockRestore();
  });

  describe("resolveConfig", () => {
    it("should resolve with only a global profile (no local override, no CLI args)", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        volumes: [{ source: "/host", target: "/container" }],
        env: {
          KEY1: "value1",
        },
        workdir: "/workspace",
        command: ["bash"],
        interactive: true,
        tty: true,
        extra: {},
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.name).toBe("test-profile");
      expect(result.projectDir).toBe("/project");
      expect(result.sessionName).toBe("default");
      expect(result.image).toBe("test-image:latest");
      expect(result.runner).toBe("docker");
      expect(result.volumes).toEqual([{ source: "/host", target: "/container" }]);
      expect(result.env).toEqual({ KEY1: "value1" });
      expect(result.workdir).toBe("/workspace");
      expect(result.command).toEqual(["bash"]);
      expect(result.interactive).toBe(true);
      expect(result.tty).toBe(true);
    });

    it("should propagate custom sessionName from options", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
        sessionName: "my-session",
      });

      expect(result.sessionName).toBe("my-session");
    });

    it("should default sessionName to 'default' when not provided", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.sessionName).toBe("default");
    });

    it("should merge local override env vars with global (local wins on conflict)", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        env: {
          KEY1: "global-value",
          KEY2: "global-only",
        },
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        env: {
          KEY1: "local-value",
          KEY3: "local-only",
        },
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.env).toEqual({
        KEY1: "local-value", // Local wins
        KEY2: "global-only",
        KEY3: "local-only",
      });
    });

    it("should replace global volumes entirely with local override volumes", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        volumes: [
          { source: "/host1", target: "/container1" },
          { source: "/host2", target: "/container2" },
        ],
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        volumes: [{ source: "/local-host", target: "/local-container" }],
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.volumes).toEqual([{ source: "/local-host", target: "/local-container" }]);
    });

    it("should apply CLI overrides on top of everything", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        env: {
          KEY1: "global",
        },
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        env: {
          KEY1: "local",
          KEY2: "local",
        },
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
        cliOverrides: {
          env: {
            KEY1: "cli",
            KEY3: "cli",
          },
        },
      });

      expect(result.env).toEqual({
        KEY1: "cli", // CLI wins
        KEY2: "local",
        KEY3: "cli",
      });
    });

    it("should interpolate ${CWD} in volume sources to project directory", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        volumes: [
          { source: "${CWD}/src", target: "/app/src" },
          { source: "${CWD}/.env", target: "/app/.env" },
        ],
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/my/project",
      });

      expect(result.volumes).toEqual([
        { source: "/my/project/src", target: "/app/src" },
        { source: "/my/project/.env", target: "/app/.env" },
      ]);
    });

    it("should apply defaults for missing optional fields", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        // All optional fields omitted
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.runner).toBe("docker");
      expect(result.volumes).toEqual([]);
      expect(result.env).toEqual({});
      expect(result.workdir).toBe("");
      expect(result.command).toEqual([]);
      expect(result.interactive).toBe(true);
      expect(result.tty).toBe(true);
      expect(result.extra).toEqual({});
    });

    it("should throw error if extends field does not match profile name", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      const localOverride: LocalOverride = {
        extends: "different-profile",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      expect(() => {
        resolveConfig({
          profileName: "test-profile",
          projectDir: "/project",
        });
      }).toThrow("Local config extends 'different-profile' but loading profile 'test-profile'");
    });

    it("should normalize string command to array", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        command: "bash -c 'echo hello'",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.command).toEqual(["bash -c 'echo hello'"]);
    });

    // TODO: Re-enable when compose field is added to AgentProfile types (per API.md)
    // it("should deep merge compose configurations", () => {
    //   const globalProfile: AgentProfile = {
    //     image: "test-image:latest",
    //     runner: "compose",
    //     compose: {
    //       services: {
    //         app: {
    //           image: "app:latest",
    //           ports: ["8080:8080"],
    //         },
    //         redis: {
    //           image: "redis:7",
    //         },
    //       },
    //     },
    //   };
    //
    //   const localOverride: LocalOverride = {
    //     extends: "test-profile",
    //     compose: {
    //       services: {
    //         app: {
    //           ports: ["3000:3000"],
    //         },
    //         postgres: {
    //           image: "postgres:14",
    //         },
    //       },
    //     },
    //   };
    //
    //   mockLoadProfile.mockReturnValue(globalProfile);
    //   mockHasLocalConfig.mockReturnValue(true);
    //   mockLoadLocalConfig.mockReturnValue(localOverride);
    //
    //   const result = resolveConfig({
    //     profileName: "test-profile",
    //     projectDir: "/project",
    //   });
    //
    //   expect(result.compose).toEqual({
    //     services: {
    //       app: {
    //         image: "app:latest",
    //         ports: ["3000:3000"], // Overridden
    //       },
    //       redis: {
    //         image: "redis:7",
    //       },
    //       postgres: {
    //         image: "postgres:14", // Added
    //       },
    //     },
    //   });
    // });

    it("should merge extra labels shallowly", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        extra: {
          labels: {
            team: "platform",
            version: "1.0",
          },
        },
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        extra: {
          labels: {
            version: "2.0", // Override
            project: "myapp", // Add
          },
        },
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.extra.labels).toEqual({
        team: "platform",
        version: "2.0", // Local wins
        project: "myapp",
      });
    });

    it("should shallow merge ssh config (local overrides individual fields)", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        ssh: {
          host: "global-host",
          port: 22,
          user: "global-user",
        },
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        ssh: {
          host: "local-host",
          user: "local-user",
        },
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.ssh).toEqual({
        host: "local-host",
        port: 22, // preserved from global
        user: "local-user", // overridden by local
      });
    });

    it("should replace mcp array entirely (local replaces global)", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        mcp: [{ name: "global-server", command: "global-cmd" }],
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        mcp: [{ name: "local-server", command: "local-cmd", args: ["--flag"] }],
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.mcp).toEqual([
        { name: "local-server", command: "local-cmd", args: ["--flag"] },
      ]);
    });

    it("should shallow merge git config", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        git: {
          token: "global-token",
          author_name: "Global Author",
        },
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        git: {
          author_name: "Local Author",
          author_email: "local@example.com",
        },
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.git).toEqual({
        token: "global-token", // preserved from global
        author_name: "Local Author", // overridden
        author_email: "local@example.com", // added
      });
    });

    it("should replace dind boolean", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        dind: false,
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        dind: true,
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.dind).toBe(true);
    });

    it("should default dind to false when not specified", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.dind).toBe(false);
    });

    it("should default agentType to 'claude' when not specified", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.agentType).toBe("claude");
    });

    it("should use specified agentType", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        agent_type: "aider",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.agentType).toBe("aider");
    });

    it("should default mcpOverride to false when not specified", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.mcpOverride).toBe(false);
    });

    it("should replace mcp_override boolean (local overrides global)", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        mcp_override: false,
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        mcp_override: true,
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.mcpOverride).toBe(true);
    });

    it("should resolve mcp_file and merge with inline mcp servers", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        mcp_file: "/path/to/mcp.json",
        mcp: [
          { name: "trello", command: "/usr/local/bin/npx", args: ["-y", "mcp-remote"] },
          { name: "extra-server", command: "npx", args: ["-y", "my-mcp-server"] },
        ],
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);
      mockLoadMcpFromFile.mockReturnValue([
        { name: "trello", command: "npx", args: ["-y", "mcp-trello"] },
        { name: "github", command: "npx", args: ["-y", "mcp-github"] },
      ]);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      // trello from inline overrides trello from file
      // github from file is kept
      // extra-server from inline is appended
      expect(result.mcp).toEqual([
        { name: "trello", command: "/usr/local/bin/npx", args: ["-y", "mcp-remote"] },
        { name: "github", command: "npx", args: ["-y", "mcp-github"] },
        { name: "extra-server", command: "npx", args: ["-y", "my-mcp-server"] },
      ]);
      expect(mockLoadMcpFromFile).toHaveBeenCalledWith("/path/to/mcp.json");
    });

    it("should resolve mcp_file without inline mcp servers", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        mcp_file: "/path/to/mcp.json",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);
      mockLoadMcpFromFile.mockReturnValue([{ name: "fs", command: "npx", args: ["-y", "mcp-fs"] }]);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.mcp).toEqual([{ name: "fs", command: "npx", args: ["-y", "mcp-fs"] }]);
    });

    it("should not call loadMcpFromFile when mcp_file is not set", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(false);

      resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(mockLoadMcpFromFile).not.toHaveBeenCalled();
    });

    it("should replace mcp_file in local override", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        mcp_file: "/global/mcp.json",
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        mcp_file: "/local/mcp.json",
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);
      mockLoadMcpFromFile.mockReturnValue([]);

      resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(mockLoadMcpFromFile).toHaveBeenCalledWith("/local/mcp.json");
    });

    it("should replace extra ports entirely", () => {
      const globalProfile: AgentProfile = {
        image: "test-image:latest",
        runner: "docker",
        extra: {
          ports: ["8080:8080", "9090:9090"],
        },
      };

      const localOverride: LocalOverride = {
        extends: "test-profile",
        extra: {
          ports: ["3000:3000"],
        },
      };

      mockLoadProfile.mockReturnValue(globalProfile);
      mockHasLocalConfig.mockReturnValue(true);
      mockLoadLocalConfig.mockReturnValue(localOverride);

      const result = resolveConfig({
        profileName: "test-profile",
        projectDir: "/project",
      });

      expect(result.extra.ports).toEqual(["3000:3000"]);
    });
  });

  describe("validateResolvedConfig", () => {
    const validConfig: ResolvedAgentConfig = {
      name: "test",
      projectDir: "/project",
      image: "test-image:latest",
      runner: "docker",
      agentType: "claude",
      volumes: [{ source: "/host", target: "/container" }],
      env: {
        KEY: "value",
      },
      workdir: "/workspace",
      command: [],
      interactive: true,
      tty: true,
      extra: {},
      dind: false,
      mcpOverride: false,
    };

    it("should return empty array for valid config", () => {
      const errors = validateResolvedConfig(validConfig);
      expect(errors).toEqual([]);
    });

    it("should catch empty image", () => {
      const config = { ...validConfig, image: "" };
      const errors = validateResolvedConfig(config);
      expect(errors).toContain("Image must be non-empty");
    });

    it("should catch whitespace-only image", () => {
      const config = { ...validConfig, image: "   " };
      const errors = validateResolvedConfig(config);
      expect(errors).toContain("Image must be non-empty");
    });

    it("should catch invalid runner type", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = { ...validConfig, runner: "invalid" as any };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("Invalid runner type"))).toBe(true);
    });

    it("should catch invalid agent type", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = { ...validConfig, agentType: "invalid" as any };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("Invalid agent type"))).toBe(true);
    });

    it("should catch relative volume source paths", () => {
      const config = {
        ...validConfig,
        volumes: [{ source: "relative/path", target: "/container" }],
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("must be an absolute path"))).toBe(true);
    });

    it("should catch empty volume source", () => {
      const config = {
        ...validConfig,
        volumes: [{ source: "", target: "/container" }],
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("source must be non-empty"))).toBe(true);
    });

    it("should catch empty volume target", () => {
      const config = {
        ...validConfig,
        volumes: [{ source: "/host", target: "" }],
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("target must be non-empty"))).toBe(true);
    });

    it("should catch non-string env var values", () => {
      const config = {
        ...validConfig,
        env: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          KEY: 123 as any,
        },
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("must be a string"))).toBe(true);
    });

    it("should catch empty ssh.host", () => {
      const config = { ...validConfig, ssh: { host: "" } };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("ssh.host must be non-empty"))).toBe(true);
    });

    it("should catch invalid ssh.port", () => {
      const config = { ...validConfig, ssh: { host: "example.com", port: 99999 } };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("ssh.port must be between"))).toBe(true);
    });

    it("should catch relative ssh.key_path", () => {
      const config = {
        ...validConfig,
        ssh: { host: "example.com", key_path: "relative/path" },
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("ssh.key_path must be an absolute path"))).toBe(true);
    });

    it("should catch empty mcp server name", () => {
      const config = {
        ...validConfig,
        mcp: [{ name: "", command: "cmd" }],
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("mcp[0].name must be non-empty"))).toBe(true);
    });

    it("should catch empty mcp server command", () => {
      const config = {
        ...validConfig,
        mcp: [{ name: "test", command: "" }],
      };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("mcp[0].command must be non-empty"))).toBe(true);
    });

    it("should catch empty git.token when specified", () => {
      const config = { ...validConfig, git: { token: "  " } };
      const errors = validateResolvedConfig(config);
      expect(errors.some((e) => e.includes("git.token must be non-empty"))).toBe(true);
    });

    it("should pass validation for valid ssh config", () => {
      const config = {
        ...validConfig,
        ssh: { host: "example.com", port: 22, key_path: "/home/user/.ssh/id_rsa" },
      };
      const errors = validateResolvedConfig(config);
      expect(errors).toEqual([]);
    });

    it("should pass validation for valid mcp config", () => {
      const config = {
        ...validConfig,
        mcp: [{ name: "server", command: "npx", args: ["-y", "pkg"] }],
      };
      const errors = validateResolvedConfig(config);
      expect(errors).toEqual([]);
    });

    it("should accumulate multiple errors", () => {
      const config: ResolvedAgentConfig = {
        ...validConfig,
        image: "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runner: "invalid" as any,
        volumes: [{ source: "relative", target: "/container" }],
        env: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          KEY: 123 as any,
        },
      };
      const errors = validateResolvedConfig(config);
      expect(errors.length).toBeGreaterThan(1);
    });
  });
});
