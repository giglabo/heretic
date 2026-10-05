import { describe, it, expect } from "bun:test";
import {
  generateDockerfile,
  agentNpmPackages,
  generateEntrypoint,
  SIDECAR_EXEC_SCRIPT,
  SSH_EXEC_SCRIPT,
  defaultImageBuildConfig,
  VALID_IMAGE_AGENTS,
  DEFAULT_BASE_IMAGE,
  generateSidecarDockerfile,
  defaultSidecarRuntimeVersion,
  isSidecarRuntime,
  EXEC_SERVER_MAIN_GO,
  EXEC_SERVER_GO_MOD,
  type ImageAgentType,
} from "../src/templates";
import { SIDECAR_RUNTIMES } from "../src/types/agent-profile";

describe("agentNpmPackages", () => {
  it("returns claude packages", () => {
    expect(agentNpmPackages("claude")).toEqual(["@anthropic-ai/claude-code", "mcp-remote"]);
  });

  it("returns copilot packages", () => {
    expect(agentNpmPackages("copilot")).toEqual(["@github/copilot"]);
  });

  it("returns opencode packages", () => {
    expect(agentNpmPackages("opencode")).toEqual(["opencode-ai"]);
  });

  it("returns gemini packages", () => {
    expect(agentNpmPackages("gemini")).toEqual(["@google/gemini-cli", "mcp-remote"]);
  });
});

describe("generateDockerfile", () => {
  it("generates a valid Dockerfile for claude agent", () => {
    const config = defaultImageBuildConfig();
    const df = generateDockerfile(config, "claude", false);

    expect(df).toContain("FROM ${BASE_IMAGE}");
    expect(df).toContain("AGENT_TYPE=");
    expect(df).toContain("@anthropic-ai/claude-code");
    expect(df).toContain("COPY sidecar-exec");
    expect(df).toContain("COPY ssh-exec");
    expect(df).toContain('CMD ["/bin/bash"]');
  });

  it("bakes the entrypoint so tool backends resolve at start-up (gap A-1)", () => {
    const config = defaultImageBuildConfig();
    const df = generateDockerfile(config, "claude", false);
    // Without a baked ENTRYPOINT, setup_tool_wrappers never runs and the
    // sidecar/SSH backends are inert.
    expect(df).toContain("COPY entrypoint.sh /entrypoint.sh");
    expect(df).toContain('ENTRYPOINT ["/entrypoint.sh"]');
    // CMD must remain so `exec "$@"` still drops to an interactive shell.
    expect(df).toContain('CMD ["/bin/bash"]');
    // ENTRYPOINT must be declared before dropping to the agent user.
    expect(df.indexOf('ENTRYPOINT ["/entrypoint.sh"]')).toBeLessThan(
      df.indexOf("USER ${AGENT_USER}")
    );
  });

  it("makes the wrapper dir writable by the agent user (gap A-3)", () => {
    const config = defaultImageBuildConfig();
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("chown ${AGENT_UID}:${AGENT_GID} /opt/sidecar/wrappers");
  });

  it("generates Dockerfile for each agent type", () => {
    const config = defaultImageBuildConfig();
    for (const agent of VALID_IMAGE_AGENTS) {
      const df = generateDockerfile(config, agent, false);
      expect(df).toContain(`AGENT_TYPE="${agent}"`);
      // Each agent should have its npm packages
      const pkgs = agentNpmPackages(agent);
      for (const pkg of pkgs) {
        expect(df).toContain(pkg);
      }
    }
  });

  it("includes Python when withPython is true", () => {
    const config = { ...defaultImageBuildConfig(), withPython: true };
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Install Python");
    expect(df).toContain("poetry");
  });

  it("includes Go when withGo is true", () => {
    const config = { ...defaultImageBuildConfig(), withGo: true };
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Install Go");
    expect(df).toContain("go.dev/dl/go");
  });

  it("includes Java when withJava is true", () => {
    const config = { ...defaultImageBuildConfig(), withJava: true };
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Install Java");
    expect(df).toContain("Maven");
    expect(df).toContain("Gradle");
  });

  it("includes Rust when withRust is true", () => {
    const config = { ...defaultImageBuildConfig(), withRust: true };
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Install Rust");
    expect(df).toContain("rustup");
    expect(df).toContain("Copy Rust installation for agent user");
  });

  it("includes Docker CLI when withDocker is true", () => {
    const config = { ...defaultImageBuildConfig(), withDocker: true };
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Install Docker CLI");
    expect(df).toContain("docker-ce-cli");
  });

  it("includes GitHub CLI when withGithubCli is true", () => {
    const config = defaultImageBuildConfig();
    expect(config.withGithubCli).toBe(true);
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Install GitHub CLI");
  });

  it("excludes GitHub CLI when withGithubCli is false", () => {
    const config = {
      ...defaultImageBuildConfig(),
      withGithubCli: false,
    };
    const df = generateDockerfile(config, "claude", false);
    expect(df).not.toContain("Install GitHub CLI");
  });

  it("generates combined mode with multiple agents", () => {
    const config = {
      ...defaultImageBuildConfig(),
      agentTypes: ["claude", "copilot", "gemini"] as ImageAgentType[],
    };
    const df = generateDockerfile(config, "claude", true);
    expect(df).toContain("Agent(s): claude, copilot, gemini");
    expect(df).toContain("Combined Mode");
    // Should include packages from all agents
    expect(df).toContain("@anthropic-ai/claude-code");
    expect(df).toContain("@github/copilot");
    expect(df).toContain("@google/gemini-cli");
  });

  it("handles ubuntu base image with locale setup", () => {
    const config = {
      ...defaultImageBuildConfig(),
      baseImage: "ubuntu:22.04",
    };
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("Configure locales for Ubuntu");
    expect(df).toContain("locale-gen en_US.UTF-8");
    // Non-node base should install Node from nodesource
    expect(df).toContain("deb.nodesource.com");
  });

  it("uses corepack enable for node base image", () => {
    const config = defaultImageBuildConfig();
    expect(config.baseImage).toBe(DEFAULT_BASE_IMAGE);
    const df = generateDockerfile(config, "claude", false);
    expect(df).toContain("corepack enable");
    expect(df).not.toContain("deb.nodesource.com");
  });

  it("creates correct directories per agent type", () => {
    const config = defaultImageBuildConfig();

    const claudeDf = generateDockerfile(config, "claude", false);
    expect(claudeDf).toContain(".claude");

    const opencodeDf = generateDockerfile(config, "opencode", false);
    expect(opencodeDf).toContain(".config/opencode");

    const geminiDf = generateDockerfile(config, "gemini", false);
    expect(geminiDf).toContain(".gemini");
  });
});

describe("generateEntrypoint", () => {
  it("generates a valid bash script", () => {
    const ep = generateEntrypoint();
    expect(ep).toStartWith("#!/bin/bash");
    expect(ep).toContain("set -e");
  });

  it("contains interactive mode section", () => {
    const ep = generateEntrypoint();
    expect(ep).toContain("Interactive Mode");
    expect(ep).toContain("exec /bin/bash");
  });

  it("contains workflow mode section", () => {
    const ep = generateEntrypoint();
    expect(ep).toContain("Workflow Mode");
    expect(ep).toContain("PROMPT_FILE");
  });

  it("contains tool wrapper setup", () => {
    const ep = generateEntrypoint();
    expect(ep).toContain("setup_tool_wrappers");
    expect(ep).toContain("RUNTIME_COMMANDS");
    expect(ep).toContain("sidecar-exec");
    expect(ep).toContain("ssh-exec");
  });

  it("probes wrapper-dir writability before writing (gap A-3)", () => {
    const ep = generateEntrypoint();
    expect(ep).toContain(".probe");
    expect(ep).toContain("is not writable");
  });

  it("handles all agent types in workflow mode", () => {
    const ep = generateEntrypoint();
    expect(ep).toContain("claude)");
    expect(ep).toContain("copilot)");
    expect(ep).toContain("opencode)");
    expect(ep).toContain("gemini)");
  });
});

describe("resource scripts", () => {
  it("SIDECAR_EXEC_SCRIPT is a real client that routes to the exec API", () => {
    expect(SIDECAR_EXEC_SCRIPT).toStartWith("#!/bin/bash");
    // It must actually reach the sidecar, not be the old always-failing stub.
    expect(SIDECAR_EXEC_SCRIPT).toContain("BUILD_SIDECARS");
    expect(SIDECAR_EXEC_SCRIPT).toContain("internal_url");
    expect(SIDECAR_EXEC_SCRIPT).toContain("/exec");
    expect(SIDECAR_EXEC_SCRIPT).toContain("/exec/stream");
    // Streaming reads via process substitution so the exit code survives (gap C-3).
    expect(SIDECAR_EXEC_SCRIPT).toContain("done < <(curl");
    // Timeout maps to 124, not an ambiguous 255 (gap C-6).
    expect(SIDECAR_EXEC_SCRIPT).toContain("exit 124");
  });

  it("SSH_EXEC_SCRIPT is a valid bash script", () => {
    expect(SSH_EXEC_SCRIPT).toStartWith("#!/bin/bash");
    expect(SSH_EXEC_SCRIPT).toContain("SSH_HOST");
    expect(SSH_EXEC_SCRIPT).toContain("exec ssh");
    expect(SSH_EXEC_SCRIPT).toContain("set -euo pipefail");
  });

  it("sidecar-exec encodes argv without jq's --args (jq 1.6 flag-parsing bug)", () => {
    // jq < 1.7 (Debian bookworm ships 1.6) does not stop option parsing after
    // `--args`, so `$ARGS.positional --args "$@"` dies on any dash-flag —
    // `npm install --save-dev`, `go build -o`, etc. The client must build the
    // argv array incrementally with `--arg`, which consumes values positionally.
    // The broken invocation must not appear as executable code.
    expect(SIDECAR_EXEC_SCRIPT).not.toContain("jq -cn '$ARGS.positional' --args");
    expect(SIDECAR_EXEC_SCRIPT).toContain('jq -c --arg x "$_arg"');
  });
});

describe("exec-server sources (build-sidecar server)", () => {
  it("embeds the Go exec-server implementing the wire contract", () => {
    expect(EXEC_SERVER_MAIN_GO).toContain("package main");
    // The four endpoints the sidecar-exec client + compose healthcheck rely on.
    expect(EXEC_SERVER_MAIN_GO).toContain('"/health"');
    expect(EXEC_SERVER_MAIN_GO).toContain('"/info"');
    expect(EXEC_SERVER_MAIN_GO).toContain('"/exec"');
    expect(EXEC_SERVER_MAIN_GO).toContain('"/exec/stream"');
    // Hardening: process-group kill (C-12) and the port-agnostic health probe (F-1).
    expect(EXEC_SERVER_MAIN_GO).toContain("Setpgid");
    expect(EXEC_SERVER_MAIN_GO).toContain('flag.Bool("healthcheck"');
  });

  it("embeds a go.mod", () => {
    expect(EXEC_SERVER_GO_MOD).toContain("module ");
    expect(EXEC_SERVER_GO_MOD).toContain("go 1.");
  });
});

describe("generateSidecarDockerfile", () => {
  it("rejects unknown runtimes and validates the five known ones", () => {
    expect(isSidecarRuntime("node")).toBe(true);
    expect(isSidecarRuntime("elixir")).toBe(false);
    // @ts-expect-error -- exercising the runtime guard with a bad value
    expect(() => generateSidecarDockerfile({ runtime: "elixir" })).toThrow();
  });

  it("generates a hardened multi-stage builder for every runtime", () => {
    for (const rt of SIDECAR_RUNTIMES) {
      const df = generateSidecarDockerfile({ runtime: rt });
      // Two-stage: compile the Go server, then copy onto the toolchain base.
      expect(df).toContain("AS exec-build");
      expect(df).toContain("COPY exec-server/ ./");
      expect(df).toContain("COPY --from=exec-build /out/exec-server /usr/local/bin/exec-server");
      // Non-root default (F-2) and the exec-server entrypoint.
      expect(df).toContain("USER builder");
      expect(df).toContain('CMD ["exec-server"]');
      expect(df).toContain(`EXEC_SERVER_RUNTIME=${rt}`);
      // Port-agnostic healthcheck (F-1): never hard-codes a numeric port here.
      expect(df).toContain('CMD ["exec-server", "-healthcheck"]');
    }
  });

  it("pins the default runtime version per runtime and honors overrides", () => {
    const nodeDf = generateSidecarDockerfile({ runtime: "node" });
    expect(nodeDf).toContain(`ARG RUNTIME_VERSION=${defaultSidecarRuntimeVersion("node")}`);
    expect(nodeDf).toContain("FROM node:${RUNTIME_VERSION}-bookworm-slim");

    const pinned = generateSidecarDockerfile({ runtime: "node", runtimeVersion: "20" });
    expect(pinned).toContain("ARG RUNTIME_VERSION=20");
  });

  it("bakes and exposes a custom port", () => {
    const df = generateSidecarDockerfile({ runtime: "go", port: 9000 });
    expect(df).toContain("EXEC_SERVER_PORT=9000");
    expect(df).toContain("EXPOSE 9000");
  });

  it("allows overriding the Go build-stage image", () => {
    const df = generateSidecarDockerfile({
      runtime: "rust",
      goBuilderImage: "golang:1.22-bookworm",
    });
    expect(df).toContain("ARG GO_BUILDER_IMAGE=golang:1.22-bookworm");
  });

  it("installs each runtime's expected toolchain", () => {
    expect(generateSidecarDockerfile({ runtime: "node" })).toContain("corepack enable");
    expect(generateSidecarDockerfile({ runtime: "python" })).toContain("poetry pytest ruff");
    expect(generateSidecarDockerfile({ runtime: "java" })).toContain("maven gradle");
    expect(generateSidecarDockerfile({ runtime: "rust" })).toContain("rustup component add");
  });
});
