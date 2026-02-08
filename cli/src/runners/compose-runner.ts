/**
 * Compose Runner Implementation
 *
 * Implements the Runner interface by generating a temporary docker-compose.yaml
 * and shelling out to `docker compose` CLI for multi-container scenarios.
 */

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ResolvedAgentConfig } from "../types/agent-profile";
import type { Runner, RunResult } from "./types";
import { stringifyYaml } from "../utils/yaml";
import { writeMcpFile, cleanupMcpFile, getMcpMountPaths, getExistingMcpPath } from "./mcp-helper";
import { getDockerSocketPath } from "../utils/docker";
import { loadSettings, resolveToken } from "../utils/settings";
import { ensureSessionDir, sanitizeSessionName } from "../utils/session";
import { getLogger } from "../logger";

const logger = getLogger();

/**
 * Compose runner that manages multi-container setups via docker-compose
 */
export class ComposeRunner implements Runner {
  private containerId?: string;
  private composeFile?: string;
  private mcpFilePath?: string;
  private projectName: string;

  constructor(private config: ResolvedAgentConfig) {
    // Generate compose project name: heretic-<agent-name>-<session> (sanitized)
    this.projectName = `heretic-${this.sanitizeProjectName(config.name)}-${this.sanitizeProjectName(config.sessionName)}`;
  }

  async start(options?: { detach?: boolean; command?: string[] }): Promise<RunResult> {
    const { detach = false, command } = options || {};

    try {
      // Check docker compose availability
      await this.checkDockerCompose();

      // Generate compose YAML
      const composeContent = this.generateComposeYaml(command);

      // Write to temp file
      this.composeFile = this.createTempFile(composeContent);
      logger.debug({ composeFile: this.composeFile }, "Created temp compose file");

      // Register cleanup handler
      this.registerCleanup();

      // Build docker compose command
      const args = ["compose", "-f", this.composeFile, "-p", this.projectName, "up"];

      if (detach) {
        args.push("-d");
      }

      logger.info({ projectName: this.projectName }, "Starting compose services");

      // Run docker compose
      const proc = Bun.spawn(["docker", ...args], {
        stdio: detach ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error(`docker compose up failed with exit code ${exitCode}`);
      }

      // Get container ID of the main agent service
      this.containerId = await this.getMainContainerId();

      logger.info(
        { containerId: this.containerId, projectName: this.projectName },
        "Compose services started"
      );

      return {
        containerId: this.containerId,
        status: detach ? "running" : "exited",
      };
    } catch (error) {
      // Cleanup on error
      await this.cleanup();
      this.handleError(error);
      throw error;
    }
  }

  async stop(options?: { timeout?: number; remove?: boolean }): Promise<void> {
    const { remove = true } = options || {};

    if (!this.composeFile) {
      throw new Error("No compose file to stop");
    }

    try {
      logger.info({ projectName: this.projectName }, "Stopping compose services");

      const args = ["compose", "-f", this.composeFile, "-p", this.projectName, "down"];

      if (remove) {
        args.push("--volumes");
      }

      const proc = Bun.spawn(["docker", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error(`docker compose down failed with exit code ${exitCode}`);
      }

      logger.info({ projectName: this.projectName }, "Compose services stopped");

      // Clean up temp file
      await this.cleanup();
      this.containerId = undefined;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async attach(): Promise<void> {
    if (!this.composeFile) {
      throw new Error("No compose file to attach to");
    }

    if (!this.containerId) {
      throw new Error("No container to attach to");
    }

    try {
      // Check if container is running
      const running = await this.isRunning();
      if (!running) {
        throw new Error("Container is not running");
      }

      logger.info(
        { containerId: this.containerId, projectName: this.projectName },
        "Attaching to agent service"
      );

      const proc = Bun.spawn(
        ["docker", "compose", "-f", this.composeFile, "-p", this.projectName, "attach", "agent"],
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
    if (!this.composeFile || !this.containerId) {
      return false;
    }

    try {
      const proc = Bun.spawn(
        [
          "docker",
          "compose",
          "-f",
          this.composeFile,
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

      // Check if agent service is running
      const agentService = services.find((s) => s.Service === "agent");
      return agentService?.State === "running";
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
   * Generate docker-compose.yaml content from config
   */
  private generateComposeYaml(commandOverride?: string[]): string {
    const { config } = this;

    // Prepare command
    let cmd: string[] | undefined;
    if (commandOverride) {
      cmd = commandOverride;
    } else if (config.command) {
      cmd = Array.isArray(config.command) ? config.command : [config.command];
    }

    // Prepare environment (start with resolved secrets, then overlay config.env)
    const environment: Record<string, string> = {
      ...(config.secrets || {}),
      ...config.env,
    };

    // Prepare volumes
    const volumes = config.volumes.map((vol) => {
      const readonly = vol.readonly ? ":ro" : "";
      return `${vol.source}:${vol.target}${readonly}`;
    });

    // SSH config → env vars + key bind
    if (config.ssh) {
      environment.SSH_HOST = config.ssh.host;
      environment.SSH_PORT = String(config.ssh.port ?? 22);
      environment.SSH_USER = config.ssh.user ?? "agent";
      if (config.ssh.key_path) {
        environment.SSH_KEY_PATH = config.ssh.key_path;
        volumes.push(`${config.ssh.key_path}:/home/agent/.ssh/id_rsa:ro`);
      }
      if (config.ssh.host_cwd) {
        environment.SSH_HOST_CWD = config.ssh.host_cwd;
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
          volumes.push(`${this.mcpFilePath}:${mountPath}`);
        }
      } else {
        logger.debug(
          { existingMcpPath },
          "Skipping MCP mount - existing MCP config found in workspace"
        );
      }
    }

    // Inject GitHub tokens from global settings
    try {
      const settings = loadSettings();
      if (settings.github?.token) {
        const ghToken = resolveToken(settings.github.token);
        environment["GH_TOKEN"] = ghToken;
        environment["GITHUB_TOKEN"] = ghToken;

        if (config.provider === "copilot") {
          const copilotToken = settings.github.copilot_token
            ? resolveToken(settings.github.copilot_token)
            : ghToken;
          environment["GH_COPILOT_TOKEN"] = copilotToken;
          environment["GITHUB_COPILOT_TOKEN"] = copilotToken;
        }
      }
    } catch (error) {
      logger.warn({ error }, "Failed to resolve GitHub tokens from settings");
    }

    // Git config → env vars (per-agent git.token overrides global settings)
    if (config.git) {
      if (config.git.token) {
        environment.GH_TOKEN = config.git.token;
        environment.GITHUB_TOKEN = config.git.token;
      }
      if (config.git.author_name) {
        environment.GIT_AUTHOR_NAME = config.git.author_name;
      }
      if (config.git.author_email) {
        environment.GIT_AUTHOR_EMAIL = config.git.author_email;
      }
    }

    // DinD → docker.sock bind
    if (config.dind) {
      const dockerSocketPath = getDockerSocketPath();
      volumes.push(`${dockerSocketPath}:/var/run/docker.sock`);
    }

    // Claude settings → merge to session dir as settings.json
    if (config.claudeSettings) {
      this.prepareClaudeSettings(config.claudeSettings);
    }

    // Mount session dir as agent home config directory (use agentType, not provider)
    const sessionDir = ensureSessionDir(config.projectDir, config.sessionName);
    if (config.agentType === "copilot-cli") {
      volumes.push(`${sessionDir}:/home/agent/.copilot`);
      volumes.push(`${sessionDir}:/root/.copilot`);
      logger.debug({ sessionDir }, "Mounting session dir as ~/.copilot");
    } else {
      // claude, aider, generic all use ~/.claude
      volumes.push(`${sessionDir}:/home/agent/.claude`);
      volumes.push(`${sessionDir}:/root/.claude`);
      logger.debug({ sessionDir }, "Mounting session dir as ~/.claude");

      // Seed .claude.json to skip onboarding/login screen
      const claudeJsonPath = join(sessionDir, ".claude.json");
      if (!existsSync(claudeJsonPath)) {
        writeFileSync(claudeJsonPath, JSON.stringify({ hasCompletedOnboarding: true }, null, 2));
        logger.debug("Seeded .claude.json with onboarding complete");
      }
      volumes.push(`${claudeJsonPath}:/home/agent/.claude.json`);
      volumes.push(`${claudeJsonPath}:/root/.claude.json`);
    }

    // Filter out env vars with empty values to avoid overriding container defaults
    // Intentionally empty values (e.g. ANTHROPIC_AUTH_TOKEN="" for OAuth mode) are preserved
    const intentionallyEmpty = new Set(
      Object.entries(config.env || {})
        .filter(([_, v]) => v === "")
        .map(([k]) => k)
    );
    for (const [key, value] of Object.entries(environment)) {
      if (value === "" && !intentionallyEmpty.has(key)) {
        delete environment[key];
      }
    }

    // Extract extra options
    const extra = config.extra || {};

    // Build labels
    const labels: Record<string, string> = {
      "heretic.managed": "true",
      "heretic.agent": config.name,
      "heretic.project": config.projectDir,
      "heretic.session": config.sessionName,
      ...(extra.labels || {}),
    };

    // Build main agent service
    const agentService: Record<string, unknown> = {
      image: config.image,
      container_name: this.generateContainerName(),
      working_dir: config.workdir,
      environment,
      volumes,
      labels,
      stdin_open: config.interactive,
      tty: config.tty,
    };

    if (cmd) {
      agentService.command = cmd;
    }

    if (extra.network) {
      agentService.network_mode = extra.network;
    }

    // Add port bindings if specified
    if (extra.ports) {
      agentService.ports = extra.ports;
    }

    // Add capabilities if specified
    if (extra.capabilities) {
      agentService.cap_add = extra.capabilities;
    }

    // Add privileged mode if specified
    if (extra.privileged) {
      agentService.privileged = extra.privileged;
    }

    // Add user if specified
    if (extra.user) {
      agentService.user = extra.user;
    }

    // Add hostname if specified
    if (extra.hostname) {
      agentService.hostname = extra.hostname;
    }

    // Add resource limits if specified
    if (extra.memory || extra.cpus || extra.shm_size) {
      const deploy: Record<string, unknown> = {
        resources: {
          limits: {} as Record<string, unknown>,
        },
      };

      if (extra.memory) {
        ((deploy.resources as Record<string, unknown>).limits as Record<string, unknown>).memory =
          extra.memory;
      }

      if (extra.cpus) {
        ((deploy.resources as Record<string, unknown>).limits as Record<string, unknown>).cpus =
          String(extra.cpus);
      }

      agentService.deploy = deploy;
    }

    if (extra.shm_size) {
      agentService.shm_size = extra.shm_size;
    }

    // Build compose spec
    const composeSpec: Record<string, unknown> = {
      version: "3.8",
      services: {
        agent: agentService,
        ...(config.compose?.services || {}),
      },
    };

    // Add networks if specified
    if (config.compose?.networks) {
      composeSpec.networks = config.compose.networks;
    }

    return stringifyYaml(composeSpec);
  }

  /**
   * Create temp file for compose YAML in session directory
   */
  private createTempFile(content: string): string {
    const sessionDir = ensureSessionDir(this.config.projectDir, this.config.sessionName);
    const filepath = join(sessionDir, "compose.yaml");

    writeFileSync(filepath, content, "utf-8");
    logger.debug({ filepath }, "Wrote compose file");

    return filepath;
  }

  /**
   * Get container ID of the main agent service
   */
  private async getMainContainerId(): Promise<string> {
    try {
      const proc = Bun.spawn(
        ["docker", "compose", "-f", this.composeFile!, "-p", this.projectName, "ps", "-q", "agent"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error("Failed to get container ID");
      }

      return output.trim();
    } catch (error) {
      logger.error({ error }, "Failed to get container ID");
      throw new Error("Failed to get container ID from compose");
    }
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
   * Sanitize project name for docker compose
   * Compose project names must be lowercase alphanumeric and dashes only
   */
  private sanitizeProjectName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
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
        result[key] = [...new Set([...globalValue, ...localValue])];
      } else if (
        localValue !== null &&
        typeof localValue === "object" &&
        !Array.isArray(localValue) &&
        globalValue !== null &&
        typeof globalValue === "object" &&
        !Array.isArray(globalValue)
      ) {
        result[key] = {
          ...(globalValue as Record<string, unknown>),
          ...(localValue as Record<string, unknown>),
        };
      } else {
        result[key] = localValue;
      }
    }

    return result;
  }

  /**
   * Prepare Claude settings file by merging global + local settings
   * Writes settings.json into session dir (visible as ~/.claude/settings.json via dir mount)
   */
  private prepareClaudeSettings(globalPath: string): void {
    const expandedGlobalPath = globalPath.startsWith("~")
      ? globalPath.replace("~", homedir())
      : globalPath;

    if (!existsSync(expandedGlobalPath)) {
      logger.warn({ globalPath: expandedGlobalPath }, "Claude settings file not found, skipping");
      return;
    }

    const localPath = join(this.config.projectDir, ".heretic", "cli", "claude-settings.json");
    const hasLocalSettings = existsSync(localPath);

    const sessionDir = ensureSessionDir(this.config.projectDir, this.config.sessionName);
    const tempPath = join(sessionDir, "settings.json");

    try {
      const globalContent = readFileSync(expandedGlobalPath, "utf-8");
      let settings = JSON.parse(globalContent) as Record<string, unknown>;

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
    } catch (error) {
      logger.error({ error, globalPath: expandedGlobalPath }, "Failed to prepare Claude settings");
    }
  }

  /**
   * Register cleanup handler for temp file
   */
  private registerCleanup(): void {
    const cleanup = async (): Promise<void> => {
      await this.cleanup();
    };

    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  /**
   * Clean up temp compose file and MCP file
   */
  private async cleanup(): Promise<void> {
    if (this.composeFile && existsSync(this.composeFile)) {
      try {
        unlinkSync(this.composeFile);
        logger.debug({ composeFile: this.composeFile }, "Deleted temp compose file");
      } catch (error) {
        logger.debug({ error, composeFile: this.composeFile }, "Failed to delete temp file");
      }
    }
    if (this.mcpFilePath) {
      cleanupMcpFile(this.mcpFilePath);
      this.mcpFilePath = undefined;
    }
  }

  /**
   * Handle and log errors with context
   */
  private handleError(error: unknown): void {
    if (error instanceof Error) {
      if (error.message.includes("docker compose")) {
        logger.error({ error }, "Docker Compose command failed");
      } else if (error.message.includes("EACCES")) {
        logger.error({ error }, "Permission denied. Check Docker socket permissions.");
      } else if (error.message.includes("ECONNREFUSED")) {
        logger.error({ error }, "Cannot connect to Docker daemon");
      } else {
        logger.error({ error }, "Compose runner operation failed");
      }
    } else {
      logger.error({ error }, "Unknown error in compose runner");
    }
  }
}
