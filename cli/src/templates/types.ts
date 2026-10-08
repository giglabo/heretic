/**
 * Types and constants for Docker image generation.
 *
 * These types are specific to the image builder and separate from the CLI's
 * AgentType used in profile management.
 */

export type ImageAgentType = "claude" | "copilot" | "opencode" | "gemini";

export const VALID_IMAGE_AGENTS: ImageAgentType[] = ["claude", "copilot", "opencode", "gemini"];

export const DEFAULT_BASE_IMAGE = "node:22-bookworm-slim";

export interface ImageBuildConfig {
  agentTypes: ImageAgentType[];
  combined: boolean;
  imageName: string;
  imageTag: string;
  registry: string;
  doPush: boolean;
  noCache: boolean;
  dryRun: boolean;
  arch: string;
  baseImage: string;
  withPython: boolean;
  pythonVersion: string;
  withNode: boolean;
  nodeVersion: string;
  withGo: boolean;
  goVersion: string;
  withJava: boolean;
  javaVersion: string;
  withRust: boolean;
  rustVersion: string;
  withDocker: boolean;
  withGithubCli: boolean;
  agentUser: string;
  agentUid: number;
  agentGid: number;
}

export function defaultImageBuildConfig(): ImageBuildConfig {
  return {
    agentTypes: ["claude"],
    combined: false,
    imageName: "heretic-agent",
    imageTag: "latest",
    registry: "",
    doPush: false,
    noCache: false,
    dryRun: false,
    arch: "",
    baseImage: DEFAULT_BASE_IMAGE,
    withPython: false,
    pythonVersion: "3.13",
    withNode: false,
    nodeVersion: "22",
    withGo: false,
    goVersion: "1.23.4",
    withJava: false,
    javaVersion: "21",
    withRust: false,
    rustVersion: "stable",
    withDocker: false,
    withGithubCli: true,
    agentUser: "agent",
    agentUid: 1000,
    agentGid: 1000,
  };
}
