import { describe, it, expect } from "bun:test";
import {
  generateDockerfile,
  agentNpmPackages,
  generateEntrypoint,
  SIDECAR_EXEC_STUB,
  SSH_EXEC_SCRIPT,
  defaultImageBuildConfig,
  VALID_IMAGE_AGENTS,
  DEFAULT_BASE_IMAGE,
  type ImageAgentType,
} from "../src/templates";

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

  it("handles all agent types in workflow mode", () => {
    const ep = generateEntrypoint();
    expect(ep).toContain("claude)");
    expect(ep).toContain("copilot)");
    expect(ep).toContain("opencode)");
    expect(ep).toContain("gemini)");
  });
});

describe("resource scripts", () => {
  it("SIDECAR_EXEC_STUB is a valid bash script", () => {
    expect(SIDECAR_EXEC_STUB).toStartWith("#!/bin/bash");
    expect(SIDECAR_EXEC_STUB).toContain("sidecar-exec");
    expect(SIDECAR_EXEC_STUB).toContain("exit 1");
  });

  it("SSH_EXEC_SCRIPT is a valid bash script", () => {
    expect(SSH_EXEC_SCRIPT).toStartWith("#!/bin/bash");
    expect(SSH_EXEC_SCRIPT).toContain("SSH_HOST");
    expect(SSH_EXEC_SCRIPT).toContain("exec ssh");
    expect(SSH_EXEC_SCRIPT).toContain("set -euo pipefail");
  });
});
