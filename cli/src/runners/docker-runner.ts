/**
 * Docker Runner Implementation
 *
 * Implements the Runner interface using dockerode to manage single-container
 * agent execution. Supports interactive TTY mode, detached mode, and
 * container lifecycle management.
 */

import type Docker from "dockerode";
import type { ContainerCreateOptions } from "dockerode";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ResolvedAgentConfig } from "../types/agent-profile";
import type { Runner, RunResult } from "./types";
import {
  getDockerClient,
  getDockerSocketPath,
  isDockerAvailable,
  pullImage,
  stopContainer,
  removeContainer,
} from "../utils/docker";
import { writeMcpFile, cleanupMcpFile, getMcpMountPaths, getExistingMcpPath } from "./mcp-helper";
import { loadSettings, resolveToken } from "../utils/settings";
import { ensureSessionDir, sanitizeSessionName } from "../utils/session";
import { getLogger } from "../logger";

const logger = getLogger();

/**
 * Docker runner that manages a single container for an agent
 */
export class DockerRunner implements Runner {
  private docker: Docker;
  private containerId?: string;
  private mcpFilePath?: string;

  constructor(private config: ResolvedAgentConfig) {
    this.docker = getDockerClient();
  }

  async start(options?: { detach?: boolean; command?: string[] }): Promise<RunResult> {
    const { detach = false, command } = options || {};

    try {
      // Check Docker availability
      const available = await isDockerAvailable(this.docker);
      if (!available) {
        throw new Error("Docker is not available. Please ensure Docker is running.");
      }

      // Check if image exists locally, pull if not
      await this.ensureImage();

      // Create container with translated config
      const containerOptions = this.translateConfig(command);
      const containerName = this.generateContainerName();

      logger.debug({ containerOptions, containerName }, "Creating container");

      // Remove existing container with same name if it exists
      await this.removeExistingContainer(containerName);

      const container = await this.docker.createContainer({
        ...containerOptions,
        name: containerName,
      });

      this.containerId = container.id;
      logger.info({ containerId: this.containerId, name: containerName }, "Container created");

      // Handle detached vs interactive mode
      if (detach) {
        // Detached mode: just start the container
        await container.start();
        logger.info({ containerId: this.containerId }, "Container started");
        await this.fixMountPermissions(container);
        return {
          containerId: this.containerId,
          status: "running",
        };
      } else {
        // Interactive mode: attach BEFORE starting so stdin is connected when shell starts
        return await this.runInteractive(container);
      }
    } catch (error) {
      // Cleanup: remove container if we created it but something failed
      if (this.containerId) {
        try {
          await removeContainer(this.containerId, { force: true }, this.docker);
        } catch (cleanupError) {
          logger.debug({ error: cleanupError }, "Failed to cleanup container");
        }
        this.containerId = undefined;
      }

      // Cleanup MCP temp file
      if (this.mcpFilePath) {
        cleanupMcpFile(this.mcpFilePath);
        this.mcpFilePath = undefined;
      }

      this.handleError(error);
      throw error;
    }
  }

  async stop(options?: { timeout?: number; remove?: boolean }): Promise<void> {
    const { timeout = 10, remove = true } = options || {};

    if (!this.containerId) {
      throw new Error("No container to stop");
    }

    try {
      logger.info({ containerId: this.containerId }, "Stopping container");
      await stopContainer(this.containerId, { t: timeout }, this.docker);

      if (remove) {
        logger.info({ containerId: this.containerId }, "Removing container");
        await removeContainer(this.containerId, {}, this.docker);
      }

      // Cleanup MCP temp file
      if (this.mcpFilePath) {
        cleanupMcpFile(this.mcpFilePath);
        this.mcpFilePath = undefined;
      }

      this.containerId = undefined;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async attach(): Promise<void> {
    if (!this.containerId) {
      throw new Error("No container to attach to");
    }

    const container = this.docker.getContainer(this.containerId);

    try {
      // Check if container is running
      const running = await this.isRunning();
      if (!running) {
        throw new Error("Container is not running");
      }

      logger.info({ containerId: this.containerId }, "Attaching to container");

      // Attach to container streams
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
      });

      // Pipe container streams to process streams
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      stream.pipe(process.stdout);
      if (process.stdin) {
        process.stdin.pipe(stream);
      }

      // Wait for container to exit
      await container.wait();

      // Restore terminal
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch (error) {
      // Restore terminal on error
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // Ignore errors restoring terminal
        }
      }

      this.handleError(error);
      throw error;
    }
  }

  async isRunning(): Promise<boolean> {
    if (!this.containerId) {
      return false;
    }

    try {
      const container = this.docker.getContainer(this.containerId);
      const info = await container.inspect();
      return info.State.Running === true;
    } catch (error) {
      logger.debug({ error, containerId: this.containerId }, "Container not found");
      return false;
    }
  }

  getContainerId(): string | undefined {
    return this.containerId;
  }

  /**
   * Ensure the Docker image is available locally, pull if not
   */
  private async ensureImage(): Promise<void> {
    const imageName = this.config.image;

    // Normalize image name for comparison (add :latest if no tag)
    const normalizedName = imageName.includes(":") ? imageName : `${imageName}:latest`;

    try {
      // Check if image exists locally
      const images = await this.docker.listImages();
      const imageExists = images.some((img) => {
        if (!img.RepoTags) return false;
        return img.RepoTags.some((tag) => {
          // Check exact match or match with :latest suffix
          return tag === imageName || tag === normalizedName;
        });
      });

      if (!imageExists) {
        logger.info({ image: imageName }, "Image not found locally, pulling...");

        await pullImage(
          imageName,
          (progress) => {
            if (progress.status && progress.id) {
              logger.debug({ id: progress.id, status: progress.status }, "Pull progress");
            }
          },
          this.docker
        );

        logger.info({ image: imageName }, "Image pulled successfully");
      } else {
        logger.debug({ image: imageName }, "Image exists locally");
      }
    } catch (error) {
      logger.error({ error, image: imageName }, "Failed to pull image");
      throw new Error(`Failed to pull image ${imageName}: ${error}`);
    }
  }

  /**
   * Remove existing container with the same name if it exists
   */
  private async removeExistingContainer(containerName: string): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const existing = containers.find((c) => c.Names.some((name) => name === `/${containerName}`));

      if (existing) {
        logger.info({ containerName }, "Removing existing container");
        await stopContainer(existing.Id, { t: 5 }, this.docker).catch(() => {
          // Container might not be running, ignore stop errors
        });
        await removeContainer(existing.Id, { force: true }, this.docker);
      }
    } catch (error) {
      logger.debug({ error, containerName }, "Failed to check/remove existing container");
      // Continue anyway - the create will fail if there's a real conflict
    }
  }

  /**
   * Translate ResolvedAgentConfig to dockerode ContainerCreateOptions
   */
  private translateConfig(commandOverride?: string[]): ContainerCreateOptions {
    const { config } = this;
    const extra = config.extra || {};

    // Translate command
    let cmd: string[] | undefined;
    if (commandOverride) {
      cmd = commandOverride;
    } else if (config.command) {
      cmd = Array.isArray(config.command) ? config.command : [config.command];
    }

    // Translate environment variables (start with resolved secrets, then overlay config.env)
    const rawEnvMap: Record<string, string> = {
      ...(config.secrets || {}),
      ...config.env,
    };

    // Filter and transform env vars for container
    const secretKeys = new Set(Object.keys(config.secrets || {}));
    const envKeys = new Set(Object.keys(config.env || {}));
    const envMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawEnvMap)) {
      // Skip keys that are in secrets but NOT in env (internal secret names)
      if (secretKeys.has(key) && !envKeys.has(key)) {
        continue;
      }
      // Rename ANTHROPIC_API_KEY to ANTHROPIC_AUTH_TOKEN + ANTHROPIC_AUTH_KEY for Claude Code
      if (key === "ANTHROPIC_API_KEY") {
        envMap["ANTHROPIC_AUTH_TOKEN"] = value;
        envMap["ANTHROPIC_AUTH_KEY"] = value;
      } else {
        envMap[key] = value;
      }
    }

    // Inject GitHub tokens from global settings
    try {
      const settings = loadSettings();
      if (settings.github?.token) {
        const ghToken = resolveToken(settings.github.token);
        envMap["GH_TOKEN"] = ghToken;
        envMap["GITHUB_TOKEN"] = ghToken;

        if (config.provider === "copilot") {
          const copilotToken = settings.github.copilot_token
            ? resolveToken(settings.github.copilot_token)
            : ghToken;
          envMap["GH_COPILOT_TOKEN"] = copilotToken;
          envMap["GITHUB_COPILOT_TOKEN"] = copilotToken;
        }
      }
    } catch (error) {
      logger.warn({ error }, "Failed to resolve GitHub tokens from settings");
    }

    // Per-agent git token overrides global settings
    if (config.git?.token) {
      envMap["GH_TOKEN"] = config.git.token;
      envMap["GITHUB_TOKEN"] = config.git.token;
    }

    // Filter out env vars with empty values to avoid overriding container defaults
    // Intentionally empty values (e.g. ANTHROPIC_AUTH_TOKEN="" for OAuth mode) are preserved
    // by checking if the key was explicitly set in config.env
    const intentionallyEmpty = new Set(
      Object.entries(config.env || {})
        .filter(([_, v]) => v === "")
        .map(([k]) => k)
    );
    for (const [key, value] of Object.entries(envMap)) {
      if (value === "" && !intentionallyEmpty.has(key)) {
        delete envMap[key];
      }
    }

    const env = Object.entries(envMap).map(([key, value]) => `${key}=${value}`);

    // Log env var names (not values for security)
    logger.info({ envVars: Object.keys(envMap) }, "Environment variables being set");
    // Debug: log env var values (masked) for troubleshooting
    for (const [key, value] of Object.entries(envMap)) {
      const masked = value.length > 4 ? value.slice(0, 4) + "****" : "****";
      logger.debug({ key, value: masked }, "Env var");
    }

    // Translate volumes
    const binds = config.volumes.map((vol) => {
      const readonly = vol.readonly ? ":ro" : "";
      return `${vol.source}:${vol.target}${readonly}`;
    });

    // SSH config → env vars + key bind
    if (config.ssh) {
      env.push(`SSH_HOST=${config.ssh.host}`);
      env.push(`SSH_PORT=${config.ssh.port ?? 22}`);
      env.push(`SSH_USER=${config.ssh.user ?? "agent"}`);
      if (config.ssh.key_path) {
        env.push(`SSH_KEY_PATH=${config.ssh.key_path}`);
        binds.push(`${config.ssh.key_path}:/home/agent/.ssh/id_rsa:ro`);
      }
      if (config.ssh.host_cwd) {
        env.push(`SSH_HOST_CWD=${config.ssh.host_cwd}`);
      }
    }

    // MCP config → temp file + bind (skip if existing MCP config found in workspace unless override enabled)
    if (config.mcp && config.mcp.length > 0) {
      const existingMcpPath = getExistingMcpPath(config.agentType, config.projectDir);
      const shouldMount = config.mcpOverride || !existsSync(existingMcpPath);

      if (shouldMount) {
        const mcpMountPaths = getMcpMountPaths(config.agentType);
        const sessionDir = ensureSessionDir(config.projectDir, config.sessionName);
        this.mcpFilePath = writeMcpFile(
          config.projectDir,
          config.mcp,
          sessionDir,
          config.agentType
        );
        for (const mountPath of mcpMountPaths) {
          binds.push(`${this.mcpFilePath}:${mountPath}`);
        }
      } else {
        logger.debug(
          { existingMcpPath },
          "Skipping MCP mount - existing MCP config found in workspace"
        );
      }
    }

    // Git config → env vars (GH_TOKEN/GITHUB_TOKEN already set in envMap above)
    if (config.git) {
      if (config.git.author_name) {
        env.push(`GIT_AUTHOR_NAME=${config.git.author_name}`);
      }
      if (config.git.author_email) {
        env.push(`GIT_AUTHOR_EMAIL=${config.git.author_email}`);
      }
    }

    // DinD → docker.sock bind
    if (config.dind) {
      const dockerSocketPath = getDockerSocketPath();
      binds.push(`${dockerSocketPath}:/var/run/docker.sock`);
    }

    // Claude settings → merge to session dir as settings.json
    if (config.claudeSettings) {
      this.prepareClaudeSettings(config.claudeSettings);
    }

    // Mount session dir as agent home config directory (use agentType, not provider)
    const sessionDir = ensureSessionDir(config.projectDir, config.sessionName);
    if (config.agentType === "copilot-cli") {
      binds.push(`${sessionDir}:/home/agent/.copilot`);
      binds.push(`${sessionDir}:/root/.copilot`);
      logger.debug({ sessionDir }, "Mounting session dir as ~/.copilot");
    } else {
      // claude, aider, generic all use ~/.claude
      binds.push(`${sessionDir}:/home/agent/.claude`);
      binds.push(`${sessionDir}:/root/.claude`);
      logger.debug({ sessionDir }, "Mounting session dir as ~/.claude");

      // Seed .claude.json to skip onboarding/login screen
      const claudeJsonPath = join(sessionDir, ".claude.json");
      if (!existsSync(claudeJsonPath)) {
        writeFileSync(claudeJsonPath, JSON.stringify({ hasCompletedOnboarding: true }, null, 2));
        logger.debug("Seeded .claude.json with onboarding complete");
      }
      binds.push(`${claudeJsonPath}:/home/agent/.claude.json`);
      binds.push(`${claudeJsonPath}:/root/.claude.json`);
    }

    // Parse memory (e.g., "4g" -> bytes)
    let memory: number | undefined;
    if (extra.memory) {
      memory = this.parseMemory(extra.memory);
    }

    // Parse CPU (e.g., "2.0" -> nanoseconds)
    let nanoCpus: number | undefined;
    if (extra.cpus) {
      nanoCpus = this.parseCpus(extra.cpus);
    }

    // Parse shm_size
    let shmSize: number | undefined;
    if (extra.shm_size) {
      shmSize = this.parseMemory(extra.shm_size);
    }

    // Build labels
    const labels: Record<string, string> = {
      "heretic.managed": "true",
      "heretic.agent": this.config.name,
      "heretic.project": this.config.projectDir,
      "heretic.session": this.config.sessionName,
      ...(extra.labels || {}),
    };

    // Translate port bindings
    let portBindings: Record<string, Array<{ HostPort: string }>> | undefined;
    if (extra.ports) {
      portBindings = this.translatePorts(extra.ports);
    }

    const options: ContainerCreateOptions = {
      Image: config.image,
      Cmd: cmd,
      WorkingDir: config.workdir,
      Env: env,
      Labels: labels,
      OpenStdin: config.interactive,
      Tty: config.tty,
      AttachStdin: config.interactive,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds,
        NetworkMode: extra.network,
        PortBindings: portBindings,
        CapAdd: extra.capabilities,
        Privileged: extra.privileged,
        Memory: memory,
        NanoCpus: nanoCpus,
        ShmSize: shmSize,
      },
      User: extra.user,
      Hostname: extra.hostname,
    };

    return options;
  }

  /**
   * Generate container name: heretic-<agent>-<session>-<hash8>
   */
  private generateContainerName(): string {
    const agent = this.config.name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const session = sanitizeSessionName(this.config.sessionName);
    const hash = createHash("sha256").update(this.config.projectDir).digest("hex").substring(0, 8);
    return `heretic-${agent}-${session}-${hash}`;
  }

  /**
   * Fix ownership of bind-mounted session directories so the container user can write.
   * Docker Desktop on macOS maps the host UID to root, so bind mounts appear as
   * root:root inside the container. This chowns them to the container's default user.
   */
  private async fixMountPermissions(container: Docker.Container): Promise<void> {
    const paths: string[] = [];
    if (this.config.agentType === "copilot-cli") {
      paths.push("/home/agent/.copilot", "/root/.copilot");
    } else {
      paths.push("/home/agent/.claude", "/root/.claude");
    }

    try {
      const exec = await container.exec({
        Cmd: ["chown", "-R", "agent:agent", ...paths],
        User: "root",
      });
      const stream = await exec.start({});
      // Wait for the chown to complete
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("error", resolve);
        stream.resume(); // drain the stream
      });
      logger.debug({ paths }, "Fixed mount permissions for container user");
    } catch (error) {
      logger.debug({ error }, "Failed to fix mount permissions (non-fatal)");
    }
  }

  /**
   * Run container in interactive mode, wait for exit
   */
  private async runInteractive(container: Docker.Container): Promise<RunResult> {
    const { spawn } = await import("child_process");

    // Start container first
    logger.info("Starting container...");
    await container.start();
    logger.info({ containerId: this.containerId }, "Container started");

    // Fix ownership of bind-mounted session directories so the container user can write
    await this.fixMountPermissions(container);

    // Use docker attach command directly - more reliable for interactive TTY
    logger.info("Attaching to container...");

    return new Promise((resolve, reject) => {
      const dockerAttach = spawn("docker", ["attach", this.containerId!], {
        stdio: "inherit", // Inherit stdin, stdout, stderr directly
      });

      dockerAttach.on("error", (err) => {
        logger.error({ error: err }, "Failed to attach to container");
        reject(err);
      });

      dockerAttach.on("close", async (code) => {
        logger.info({ containerId: this.containerId, exitCode: code }, "Container session ended");

        // Get actual container exit code
        try {
          const info = await container.inspect();
          const exitCode = info.State.ExitCode;
          resolve({
            containerId: this.containerId!,
            exitCode,
            status: "exited",
          });
        } catch {
          resolve({
            containerId: this.containerId!,
            exitCode: code ?? 0,
            status: "exited",
          });
        }
      });
    });
  }

  /**
   * Parse memory string (e.g., "4g", "512m") to bytes
   */
  private parseMemory(memory: string): number {
    const match = memory.match(/^(\d+(?:\.\d+)?)(b|k|m|g)?$/i);
    if (!match) {
      throw new Error(`Invalid memory format: ${memory}`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || "b").toLowerCase();

    const multipliers: Record<string, number> = {
      b: 1,
      k: 1024,
      m: 1024 ** 2,
      g: 1024 ** 3,
    };

    return Math.floor(value * multipliers[unit]);
  }

  /**
   * Parse CPU value (e.g., "2.0", 2) to nanoseconds (for NanoCpus)
   */
  private parseCpus(cpus: string | number): number {
    const value = typeof cpus === "string" ? parseFloat(cpus) : cpus;
    if (isNaN(value)) {
      throw new Error(`Invalid CPU value: ${cpus}`);
    }
    return Math.floor(value * 1e9);
  }

  /**
   * Translate port array (e.g., ["8080:80", "3000"]) to PortBindings
   */
  private translatePorts(ports: string[]): Record<string, Array<{ HostPort: string }>> {
    const bindings: Record<string, Array<{ HostPort: string }>> = {};

    for (const port of ports) {
      const parts = port.split(":");
      if (parts.length === 1) {
        // Format: "8080" -> bind same port
        const containerPort = parts[0];
        bindings[`${containerPort}/tcp`] = [{ HostPort: containerPort }];
      } else if (parts.length === 2) {
        // Format: "8080:80" -> bind host:container
        const [hostPort, containerPort] = parts;
        bindings[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
      } else {
        throw new Error(`Invalid port format: ${port}`);
      }
    }

    return bindings;
  }

  /**
   * Merge two claude settings objects
   * Arrays are unioned, objects are shallow merged (local wins)
   */
  private mergeClaudeSettings(
    global: Record<string, unknown>,
    local: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...global };

    for (const [key, localValue] of Object.entries(local)) {
      const globalValue = global[key];

      if (Array.isArray(localValue) && Array.isArray(globalValue)) {
        // Union arrays (deduplicate)
        result[key] = [...new Set([...globalValue, ...localValue])];
      } else if (
        localValue !== null &&
        typeof localValue === "object" &&
        !Array.isArray(localValue) &&
        globalValue !== null &&
        typeof globalValue === "object" &&
        !Array.isArray(globalValue)
      ) {
        // Shallow merge objects
        result[key] = {
          ...(globalValue as Record<string, unknown>),
          ...(localValue as Record<string, unknown>),
        };
      } else {
        // Replace primitives and mismatched types
        result[key] = localValue;
      }
    }

    return result;
  }

  /**
   * Prepare Claude settings file by merging global + local settings
   * Auto-detects local settings at .heretic/cli/claude-settings.json
   * Returns the temp file path or undefined if global doesn't exist
   */
  private prepareClaudeSettings(globalPath: string): string | undefined {
    // Expand ~ in global path
    const expandedGlobalPath = globalPath.startsWith("~")
      ? globalPath.replace("~", homedir())
      : globalPath;

    if (!existsSync(expandedGlobalPath)) {
      logger.warn(
        { globalPath: expandedGlobalPath },
        "Claude settings file not found, skipping mount"
      );
      return undefined;
    }

    // Check for local settings (auto-detect)
    const localPath = join(this.config.projectDir, ".heretic", "cli", "claude-settings.json");
    const hasLocalSettings = existsSync(localPath);

    // Write as settings.json in session dir (visible as ~/.claude/settings.json via dir mount)
    const sessionDir = ensureSessionDir(this.config.projectDir, this.config.sessionName);
    const tempPath = join(sessionDir, "settings.json");

    try {
      // Load global settings
      const globalContent = readFileSync(expandedGlobalPath, "utf-8");
      let settings = JSON.parse(globalContent) as Record<string, unknown>;

      // Merge with local if exists
      if (hasLocalSettings) {
        const localContent = readFileSync(localPath, "utf-8");
        const localSettings = JSON.parse(localContent) as Record<string, unknown>;
        settings = this.mergeClaudeSettings(settings, localSettings);
        logger.debug(
          { globalPath: expandedGlobalPath, localPath },
          "Merged global + local Claude settings"
        );
      } else {
        logger.debug(
          { globalPath: expandedGlobalPath },
          "Using global Claude settings (no local override)"
        );
      }

      writeFileSync(tempPath, JSON.stringify(settings, null, 2));
      return tempPath;
    } catch (error) {
      logger.error({ error, globalPath: expandedGlobalPath }, "Failed to prepare Claude settings");
      return undefined;
    }
  }

  /**
   * Handle and log errors with context
   */
  private handleError(error: unknown): void {
    const err = error as Record<string, unknown>;
    if (err.statusCode === 404) {
      logger.error({ error }, "Container or image not found");
    } else if (err.statusCode === 409) {
      logger.error({ error }, "Container conflict (name or port already in use)");
    } else if (err.errno === "EACCES") {
      logger.error(
        { error },
        "Permission denied. Try running with sudo or check Docker socket permissions."
      );
    } else if (err.errno === "ECONNREFUSED") {
      logger.error({ error }, "Cannot connect to Docker daemon");
    } else {
      logger.error({ error }, "Docker operation failed");
    }
  }
}
