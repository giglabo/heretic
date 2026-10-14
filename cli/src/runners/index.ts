/**
 * Runners Index
 *
 * Exports all runner implementations and factory functions.
 */

import type { ResolvedAgentConfig } from "../types/agent-profile";
import type { Runner } from "./types";
import { DockerRunner } from "./docker-runner";
import { ComposeRunner } from "./compose-runner";
import { CustomRunner } from "./custom-runner";

/**
 * Factory function to create the appropriate runner based on config
 *
 * @param config - Resolved agent configuration
 * @returns Runner instance (DockerRunner, ComposeRunner, or CustomRunner)
 * @throws Error if runner type is invalid
 */
export function createRunner(config: ResolvedAgentConfig): Runner {
  switch (config.runner) {
    case "docker":
      return new DockerRunner(config);
    case "compose":
      return new ComposeRunner(config);
    case "custom":
      return new CustomRunner(config);
    default:
      throw new Error(
        `Unknown runner type '${config.runner}'. Valid types: docker, compose, custom`
      );
  }
}

// Re-export runner classes for direct use
export { DockerRunner } from "./docker-runner";
export { ComposeRunner } from "./compose-runner";
export { CustomRunner } from "./custom-runner";

// Re-export types and interfaces
export type { Runner, RunResult, RunnerConstructor } from "./types";
