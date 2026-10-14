/**
 * Dockerfile generation for Heretic Agent images.
 *
 * Uses a Handlebars template (assets/Dockerfile.hbs) with a pre-computed
 * context object. Pure functions — no I/O.
 */

import Handlebars from "handlebars";
import { DEFAULT_BASE_IMAGE, type ImageAgentType, type ImageBuildConfig } from "./types";

// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import dockerfileTemplate from "./assets/Dockerfile.hbs" with { type: "text" };

const compiledTemplate = Handlebars.compile(dockerfileTemplate, { noEscape: true });

/**
 * Return the npm packages to install for a given agent type.
 */
export function agentNpmPackages(agent: ImageAgentType): string[] {
  switch (agent) {
    case "claude":
      return ["@anthropic-ai/claude-code", "mcp-remote"];
    case "copilot":
      return ["@github/copilot"];
    case "opencode":
      return ["opencode-ai"];
    case "gemini":
      return ["@google/gemini-cli", "mcp-remote"];
  }
}

/**
 * Compute the directories to create per agent type.
 */
function agentDirsForType(agentType: ImageAgentType): string {
  const dirMap: Record<ImageAgentType, string> = {
    claude: "/home/${AGENT_USER}/.claude /workspace",
    copilot: "/workspace",
    opencode: "/home/${AGENT_USER}/.config/opencode /workspace",
    gemini: "/home/${AGENT_USER}/.gemini /workspace",
  };
  return dirMap[agentType];
}

/**
 * Generate a complete Dockerfile for the given configuration.
 */
export function generateDockerfile(
  config: ImageBuildConfig,
  agentType: ImageAgentType,
  combinedMode: boolean
): string {
  const agents = combinedMode ? config.agentTypes : [agentType];
  const agentLabel = combinedMode ? agents.join("+") : agentType;

  // Pre-compute npm packages
  let npmPackages: string;
  let npmInstallComment: string;
  if (combinedMode) {
    const pkgs = new Set<string>();
    for (const a of agents) {
      for (const p of agentNpmPackages(a)) pkgs.add(p);
    }
    npmPackages = [...pkgs].join(" ");
    npmInstallComment = "Install Agent CLIs (Combined Mode)";
  } else {
    npmPackages = agentNpmPackages(agentType).join(" ");
    npmInstallComment = `Install ${agentType} CLI`;
  }

  // Pre-compute directories
  let agentDirs: string;
  let dirSectionComment: string;
  if (combinedMode) {
    agentDirs =
      "/workspace /home/${AGENT_USER}/.claude /home/${AGENT_USER}/.config/opencode /home/${AGENT_USER}/.gemini";
    dirSectionComment = "Setup directories for all agents (Combined Mode)";
  } else {
    agentDirs = agentDirsForType(agentType);
    dirSectionComment = `Setup ${agentType}-specific directories`;
  }

  const context = {
    agents,
    agentsList: agents.join(", "),
    agentLabel,
    agentType,
    agentUser: config.agentUser,
    agentUid: config.agentUid,
    agentGid: config.agentGid,
    defaultBaseImage: DEFAULT_BASE_IMAGE,
    isUbuntuBase: config.baseImage.startsWith("ubuntu:"),
    isNodeBase: config.baseImage.startsWith("node:"),
    nodeVersion: config.nodeVersion,
    withPython: config.withPython,
    pythonVersion: config.pythonVersion,
    pythonVersionSpecific: config.pythonVersion && config.pythonVersion !== "default",
    withGo: config.withGo,
    goVersion: config.goVersion,
    withJava: config.withJava,
    javaVersion: config.javaVersion,
    withRust: config.withRust,
    rustVersion: config.rustVersion,
    withDocker: config.withDocker,
    withGithubCli: config.withGithubCli,
    combinedMode,
    npmInstallComment,
    npmPackages,
    dirSectionComment,
    agentDirs,
  };

  return compiledTemplate(context);
}
