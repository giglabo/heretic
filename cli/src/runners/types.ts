/**
 * Docker Runner Types
 *
 * Defines the abstract Runner interface that all Docker runner backends
 * (docker, compose, custom) must implement.
 */

import type { ResolvedAgentConfig } from "../types/agent-profile";

/**
 * Result returned from starting a container
 */
export interface RunResult {
  /** Docker container ID */
  containerId: string;
  /** Exit code if container has exited */
  exitCode?: number;
  /** Current status of the container */
  status: "running" | "exited" | "error";
}

/**
 * Runner interface that all Docker runner backends implement.
 *
 * Each backend (docker, compose, custom) provides its own implementation
 * while conforming to this common interface.
 */
export interface Runner {
  /**
   * Start the agent container.
   *
   * In interactive mode (default), this method blocks until the container exits.
   * In detached mode, this method returns immediately after the container starts.
   *
   * @param options - Start options
   * @param options.detach - Run container in background (detached mode)
   * @param options.command - Override the default command specified in config
   * @returns RunResult with container ID and status
   */
  start(options?: { detach?: boolean; command?: string[] }): Promise<RunResult>;

  /**
   * Stop the running container.
   *
   * Sends SIGTERM to the container and waits for graceful shutdown.
   * If timeout expires, sends SIGKILL.
   *
   * @param options - Stop options
   * @param options.timeout - Seconds to wait before forcing kill (default: 10)
   * @param options.remove - Remove the container after stopping (default: true)
   */
  stop(options?: { timeout?: number; remove?: boolean }): Promise<void>;

  /**
   * Attach stdin/stdout/stderr to the running container.
   *
   * Allows interaction with a detached container. This method blocks
   * until the container exits or the user detaches (Ctrl+P, Ctrl+Q).
   *
   * @throws Error if container is not running or does not exist
   */
  attach(): Promise<void>;

  /**
   * Check if the container is currently running.
   *
   * @returns true if the container exists and is in "running" state
   */
  isRunning(): Promise<boolean>;

  /**
   * Get the Docker container ID.
   *
   * @returns Container ID if the runner has started a container, undefined otherwise
   */
  getContainerId(): string | undefined;
}

/**
 * Constructor type for creating runner instances.
 *
 * All runner implementations must have a constructor that accepts
 * a ResolvedAgentConfig.
 */
export type RunnerConstructor = new (config: ResolvedAgentConfig) => Runner;
