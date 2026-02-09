/**
 * Custom Runner Implementation
 *
 * Implements the Runner interface by using an existing .heretic/cli/compose.yaml
 * file from the project directory without any modification. The compose file
 * is passed directly to `docker compose` with environment variables from the
 * resolved config available for variable interpolation.
 */

import { existsSync } from "node:fs";
import type { ResolvedAgentConfig } from "../types/agent-profile";
import type { Runner, RunResult } from "./types";
import { getLocalComposePath } from "../utils/local-config";
import { loadSettings, resolveToken } from "../utils/settings";
import { getLogger } from "../logger";

const logger = getLogger();

/**
 * Custom runner that uses existing .heretic/cli/compose.yaml as-is
 */
export class CustomRunner implements Runner {
  private containerId?: string;
  private composePath: string;
  private projectName: string;

  constructor(private config: ResolvedAgentConfig) {
    // Get path to .heretic/cli/compose.yaml
    this.composePath = getLocalComposePath(config.projectDir);

    // Validate that compose file exists
    if (!existsSync(this.composePath)) {
      throw new Error(
        `Custom compose file not found: ${this.composePath}\n` +
          `The custom runner requires a .heretic/cli/compose.yaml file in your project directory.`
      );
    }

    // Generate compose project name: heretic-<agent-name> (sanitized)
    this.projectName = `heretic-${this.sanitizeProjectName(config.name)}`;

    logger.debug(
      { composePath: this.composePath, projectName: this.projectName },
      "Custom runner initialized"
    );
  }

  async start(options?: { detach?: boolean; command?: string[] }): Promise<RunResult> {
    const { detach = false } = options || {};

    try {
      // Validate compose file still exists
      if (!existsSync(this.composePath)) {
        throw new Error(`Compose file not found: ${this.composePath}`);
      }

      // Check docker compose availability
      await this.checkDockerCompose();

      // Build docker compose command
      const args = ["compose", "-f", this.composePath, "-p", this.projectName, "up"];

      if (detach) {
        args.push("-d");
      }

      logger.info(
        { projectName: this.projectName, composePath: this.composePath },
        "Starting custom compose services"
      );

      // Prepare environment variables from config (secrets first, then config.env overlays)
      const env: Record<string, string | undefined> = {
        ...process.env,
      };

      // Inject GitHub tokens from global settings
      try {
        const settings = loadSettings();
        if (settings.github?.token) {
          const ghToken = resolveToken(settings.github.token);
          env["GH_TOKEN"] = ghToken;
          env["GITHUB_TOKEN"] = ghToken;

          if (this.config.provider === "copilot") {
            const copilotToken = settings.github.copilot_token
              ? resolveToken(settings.github.copilot_token)
              : ghToken;
            env["GH_COPILOT_TOKEN"] = copilotToken;
            env["GITHUB_COPILOT_TOKEN"] = copilotToken;
          }
        }
      } catch (error) {
        logger.warn({ error }, "Failed to resolve GitHub tokens from settings");
      }

      // Apply agent config overlays (overrides settings tokens if set)
      Object.assign(env, this.config.secrets || {}, this.config.env);

      // Filter out env vars with empty values to avoid overriding container defaults
      // Intentionally empty values (e.g. ANTHROPIC_AUTH_TOKEN="" for OAuth mode) are preserved
      const intentionallyEmpty = new Set(
        Object.entries(this.config.env || {})
          .filter(([_, v]) => v === "")
          .map(([k]) => k)
      );
      for (const [key, value] of Object.entries(env)) {
        if (value === "" && !intentionallyEmpty.has(key)) {
          delete env[key];
        }
      }

      // Run docker compose with environment variables
      const proc = Bun.spawn(["docker", ...args], {
        stdio: detach ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
        env,
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        let stderr = "";
        if (detach && proc.stderr) {
          stderr = await new Response(proc.stderr).text();
        }
        throw new Error(
          `docker compose up failed with exit code ${exitCode}${stderr ? `:\n${stderr}` : ""}`
        );
      }

      // Get container ID of the first service
      this.containerId = await this.getFirstContainerId();

      logger.info(
        { containerId: this.containerId, projectName: this.projectName },
        "Custom compose services started"
      );

      return {
        containerId: this.containerId,
        status: detach ? "running" : "exited",
      };
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async stop(options?: { timeout?: number; remove?: boolean }): Promise<void> {
    const { timeout, remove = true } = options || {};

    try {
      logger.info({ projectName: this.projectName }, "Stopping custom compose services");

      const args = ["compose", "-f", this.composePath, "-p", this.projectName, "down"];

      if (timeout !== undefined) {
        args.push("--timeout", String(timeout));
      }

      if (remove) {
        args.push("--volumes");
      }

      const proc = Bun.spawn(["docker", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `docker compose down failed with exit code ${exitCode}${stderr ? `:\n${stderr}` : ""}`
        );
      }

      logger.info({ projectName: this.projectName }, "Custom compose services stopped");

      this.containerId = undefined;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async attach(): Promise<void> {
    if (!this.containerId) {
      throw new Error("No container to attach to. Start the runner first.");
    }

    try {
      // Check if container is running
      const running = await this.isRunning();
      if (!running) {
        throw new Error("Container is not running");
      }

      // Get first service name
      const serviceName = await this.getFirstServiceName();

      logger.info(
        { containerId: this.containerId, projectName: this.projectName, serviceName },
        "Attaching to service"
      );

      const proc = Bun.spawn(
        [
          "docker",
          "compose",
          "-f",
          this.composePath,
          "-p",
          this.projectName,
          "attach",
          serviceName,
        ],
        {
          stdio: ["inherit", "inherit", "inherit"],
        }
      );

      await proc.exited;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async isRunning(): Promise<boolean> {
    if (!this.containerId) {
      return false;
    }

    try {
      const proc = Bun.spawn(
        [
          "docker",
          "compose",
          "-f",
          this.composePath,
          "-p",
          this.projectName,
          "ps",
          "--format",
          "json",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return false;
      }

      // Parse JSON output (array of service status objects)
      const services = JSON.parse(output) as Array<{
        Name: string;
        State: string;
        Service: string;
      }>;

      // Check if any service is running
      return services.some((s) => s.State === "running");
    } catch (error) {
      logger.debug({ error, containerId: this.containerId }, "Failed to check status");
      return false;
    }
  }

  getContainerId(): string | undefined {
    return this.containerId;
  }

  /**
   * Check if docker compose v2 is available
   */
  private async checkDockerCompose(): Promise<void> {
    const proc = Bun.spawn(["docker", "compose", "version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(
        "docker compose v2 is not available. Please install Docker Compose v2 (included with Docker Desktop or docker-compose-plugin)."
      );
    }
  }

  /**
   * Get container ID of the first service
   */
  private async getFirstContainerId(): Promise<string> {
    try {
      // Get first service name
      const serviceName = await this.getFirstServiceName();

      const proc = Bun.spawn(
        [
          "docker",
          "compose",
          "-f",
          this.composePath,
          "-p",
          this.projectName,
          "ps",
          "-q",
          serviceName,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error("Failed to get container ID");
      }

      const id = output.trim();
      if (!id) {
        throw new Error("No container ID returned from compose ps");
      }

      return id;
    } catch (error) {
      logger.error({ error }, "Failed to get container ID");
      throw new Error("Failed to get container ID from compose");
    }
  }

  /**
   * Get the first service name from the compose file
   */
  private async getFirstServiceName(): Promise<string> {
    try {
      const proc = Bun.spawn(
        ["docker", "compose", "-f", this.composePath, "-p", this.projectName, "ps", "--services"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error("Failed to list services");
      }

      const services = output.trim().split("\n").filter(Boolean);
      if (services.length === 0) {
        throw new Error("No services found in compose file");
      }

      return services[0];
    } catch (error) {
      logger.error({ error }, "Failed to get service name");
      throw new Error("Failed to get service name from compose");
    }
  }

  /**
   * Sanitize project name for docker compose
   * Compose project names must be lowercase alphanumeric and dashes only
   */
  private sanitizeProjectName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }

  /**
   * Handle and log errors with context
   */
  private handleError(error: unknown): void {
    if (error instanceof Error) {
      if (error.message.includes("docker compose")) {
        logger.error({ error }, "Docker Compose command failed");
      } else if (error.message.includes("not found")) {
        logger.error({ error }, "Compose file not found");
      } else if (error.message.includes("EACCES")) {
        logger.error({ error }, "Permission denied. Check Docker socket permissions.");
      } else if (error.message.includes("ECONNREFUSED")) {
        logger.error({ error }, "Cannot connect to Docker daemon");
      } else {
        logger.error({ error }, "Custom runner operation failed");
      }
    } else {
      logger.error({ error }, "Unknown error in custom runner");
    }
  }
}
