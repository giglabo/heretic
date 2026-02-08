import { isAbsolute } from "path";
import { loadProfile } from "./profile-loader";
import { hasLocalConfig, loadLocalConfig } from "./local-config";
import { interpolateConfig, buildVariableContext, resolveSecrets } from "./interpolation";
import { loadMcpFromFile } from "../runners/mcp-helper";
import type {
  AgentProfile,
  ResolvedAgentConfig,
  VolumeMount,
  RunnerType,
  AgentType,
  AgentProfileExtra,
  SshConfig,
  McpServer,
  GitConfig,
} from "../types/agent-profile";
import { providerFromAgentType } from "../types/agent-profile";
import { getLogger } from "../logger";

const logger = getLogger();

/**
 * Options for resolving agent configuration
 */
export interface ResolveOptions {
  /** Name of the global profile to use */
  profileName: string;
  /** Project directory (for local overrides and CWD variable) */
  projectDir: string;
  /** CLI-provided overrides */
  cliOverrides?: Partial<AgentProfile>;
  /** Session name for this run (default: "default") */
  sessionName?: string;
}

/**
 * Resolve all config layers into a single ResolvedAgentConfig.
 *
 * Merge order: global profile → local override → CLI args (later wins)
 * Variable interpolation runs AFTER merge on the combined result.
 *
 * @param options - Resolution options with profile name, project dir, and CLI overrides
 * @returns Fully resolved and validated agent configuration
 * @throws Error if profile not found, extends mismatch, or validation fails
 */
export function resolveConfig(options: ResolveOptions): ResolvedAgentConfig {
  const { profileName, projectDir, cliOverrides } = options;

  logger.debug({ profileName, projectDir }, "Resolving config");

  // 1. Load global profile
  const globalProfile = loadProfile(profileName);
  logger.debug({ profileName }, "Loaded global profile");

  // 2. Check for local override
  let localOverride: Partial<AgentProfile> | null = null;

  if (hasLocalConfig(projectDir, profileName)) {
    const localConfig = loadLocalConfig(projectDir, profileName);

    // Verify extends matches the profile being loaded
    if (localConfig.extends && localConfig.extends !== profileName) {
      throw new Error(
        `Local config extends '${localConfig.extends}' but loading profile '${profileName}'`
      );
    }

    localOverride = localConfig;
    logger.debug({ extends: localConfig.extends }, "Loaded local override");
  }

  // 3. Deep merge: global → local → CLI
  let merged = { ...globalProfile };

  if (localOverride) {
    merged = mergeConfigs(merged, localOverride);
    logger.debug("Merged local override");
  }

  if (cliOverrides) {
    merged = mergeConfigs(merged, cliOverrides);
    logger.debug("Merged CLI overrides");
  }

  // 4. Build variable context
  let variableContext = buildVariableContext(projectDir);

  // 5. Resolve secrets (if any) and merge into context
  let resolvedSecrets: Record<string, string> | undefined;
  if (merged.secrets && Object.keys(merged.secrets).length > 0) {
    logger.debug({ secretCount: Object.keys(merged.secrets).length }, "Resolving secrets");
    resolvedSecrets = resolveSecrets(merged.secrets);

    // Merge secrets into variable context so they can be used in ${VAR} interpolation
    variableContext = {
      ...variableContext,
      ...resolvedSecrets,
    };
    logger.debug("Secrets resolved and merged into context");
  }

  // 6. Interpolate all string values
  const interpolated = interpolateConfig(merged, variableContext);
  logger.debug("Applied variable interpolation");

  // 6b. Resolve mcp_file: load servers from JSON file and merge with inline mcp
  if (interpolated.mcp_file) {
    const fileServers = loadMcpFromFile(interpolated.mcp_file);
    const inlineServers = interpolated.mcp || [];

    // Build name→server map: file servers as base, inline overrides by name or appends
    const serverMap = new Map<string, McpServer>();
    for (const s of fileServers) {
      serverMap.set(s.name, s);
    }
    for (const s of inlineServers) {
      serverMap.set(s.name, s);
    }
    interpolated.mcp = [...serverMap.values()];
    logger.debug(
      { mcpFile: interpolated.mcp_file, serverCount: interpolated.mcp.length },
      "Resolved mcp_file and merged with inline mcp servers"
    );
  }

  // 7. Apply defaults for missing fields (trim strings to prevent whitespace issues)
  const resolved: ResolvedAgentConfig = {
    name: profileName,
    projectDir: projectDir,
    sessionName: options.sessionName || "default",
    image: interpolated.image?.trim() || "",
    runner: interpolated.runner || "docker",
    agentType: interpolated.agent_type || "claude",
    provider: interpolated.provider || providerFromAgentType(interpolated.agent_type || "claude"),
    volumes: interpolated.volumes || [],
    env: interpolated.env || {},
    workdir: interpolated.workdir || "",
    command: normalizeCommand(interpolated.command),
    interactive: interpolated.interactive !== undefined ? interpolated.interactive : true,
    tty: interpolated.tty !== undefined ? interpolated.tty : true,
    extra: interpolated.extra || {},
    compose: interpolated.compose,
    ssh: interpolated.ssh,
    mcp: interpolated.mcp,
    mcpOverride: interpolated.mcp_override ?? false,
    git: interpolated.git,
    dind: interpolated.dind ?? false,
    secrets: resolvedSecrets,
    claudeSettings: interpolated.claude_settings,
  };

  // 8. Validate the final result
  const errors = validateResolvedConfig(resolved);
  if (errors.length > 0) {
    throw new Error(`Config validation failed: ${errors.join(", ")}`);
  }

  logger.debug({ resolved }, "Config resolved successfully");
  return resolved;
}

/**
 * Normalize command field to always be an array
 */
function normalizeCommand(command: string | string[] | undefined): string[] {
  if (!command) {
    return [];
  }
  if (typeof command === "string") {
    return [command];
  }
  return command;
}

/**
 * Deep merge two config objects following the merge rules from CONFIG-SCHEMA.md
 *
 * Rules:
 * - Replace fields: image, runner, volumes, workdir, command, interactive, tty
 * - Shallow merge fields: env, extra, extra.labels
 * - Replace within extra: ports, capabilities
 * - Deep merge: compose
 *
 * @param base - Base configuration
 * @param override - Override configuration
 * @returns Merged configuration (new object, inputs not mutated)
 */
function mergeConfigs<T extends Partial<AgentProfile>>(
  base: T,
  override: Partial<AgentProfile>
): T {
  const result: Partial<AgentProfile> = { ...base };

  // Replace fields (scalars and arrays that replace entirely)
  if (override.image !== undefined) result.image = override.image;
  if (override.runner !== undefined) result.runner = override.runner;
  if (override.agent_type !== undefined) result.agent_type = override.agent_type;
  if (override.provider !== undefined) result.provider = override.provider;
  if (override.volumes !== undefined) result.volumes = [...override.volumes];
  if (override.workdir !== undefined) result.workdir = override.workdir;
  if (override.command !== undefined) {
    result.command = Array.isArray(override.command) ? [...override.command] : override.command;
  }
  if (override.interactive !== undefined) result.interactive = override.interactive;
  if (override.tty !== undefined) result.tty = override.tty;

  // Shallow merge: env
  if (override.env !== undefined) {
    result.env = {
      ...(base.env || {}),
      ...override.env,
    };
  }

  // Shallow merge: extra (with special handling for nested fields)
  if (override.extra !== undefined) {
    const baseExtra = (base.extra || {}) as AgentProfileExtra;
    const overrideExtra = override.extra;

    result.extra = {
      ...baseExtra,
      ...overrideExtra,
    };

    // Replace arrays within extra
    if (overrideExtra.ports) {
      result.extra.ports = [...overrideExtra.ports];
    }
    if (overrideExtra.capabilities) {
      result.extra.capabilities = [...overrideExtra.capabilities];
    }

    // Shallow merge labels within extra
    if (overrideExtra.labels) {
      result.extra.labels = {
        ...(baseExtra.labels || {}),
        ...overrideExtra.labels,
      };
    }
  }

  // Shallow merge: ssh
  if (override.ssh !== undefined) {
    result.ssh = {
      ...(base.ssh || {}),
      ...override.ssh,
    } as SshConfig;
  }

  // Replace: mcp (array replaces entirely)
  if (override.mcp !== undefined) {
    result.mcp = [...override.mcp];
  }

  // Replace: mcp_file (string path)
  if (override.mcp_file !== undefined) {
    result.mcp_file = override.mcp_file;
  }

  // Replace: mcp_override (boolean)
  if (override.mcp_override !== undefined) {
    result.mcp_override = override.mcp_override;
  }

  // Shallow merge: git
  if (override.git !== undefined) {
    result.git = {
      ...(base.git || {}),
      ...override.git,
    } as GitConfig;
  }

  // Replace: dind (boolean)
  if (override.dind !== undefined) {
    result.dind = override.dind;
  }

  // Deep merge: compose
  if (override.compose !== undefined) {
    if (base.compose) {
      result.compose = deepMergeCompose(
        base.compose as Record<string, unknown>,
        override.compose as Record<string, unknown>
      ) as typeof result.compose;
    } else {
      result.compose = JSON.parse(JSON.stringify(override.compose));
    }
  }

  // Shallow merge: secrets
  if (override.secrets !== undefined) {
    result.secrets = {
      ...(base.secrets || {}),
      ...override.secrets,
    };
  }

  // Replace: claude_settings
  if (override.claude_settings !== undefined) {
    result.claude_settings = override.claude_settings;
  }

  return result as T;
}

/**
 * Deep merge compose configurations
 * Merges services, networks, and volumes objects recursively
 */
function deepMergeCompose(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown>
): Record<string, unknown> {
  if (!base) {
    return JSON.parse(JSON.stringify(override)); // Deep clone
  }

  const result: Record<string, unknown> = JSON.parse(JSON.stringify(base)); // Deep clone

  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Deep merge objects
      result[key] = deepMergeCompose(
        result[key] as Record<string, unknown> | undefined,
        value as Record<string, unknown>
      );
    } else {
      // Replace primitives and arrays
      result[key] = JSON.parse(JSON.stringify(value)); // Deep clone
    }
  }

  return result;
}

/**
 * Validate a resolved config.
 *
 * Checks:
 * - Image is non-empty
 * - All volume sources are absolute paths
 * - All env var values are strings
 * - Runner type is valid
 *
 * @param config - Resolved agent configuration to validate
 * @returns Array of error messages (empty array = valid)
 */
export function validateResolvedConfig(config: ResolvedAgentConfig): string[] {
  const errors: string[] = [];

  // Image must be non-empty
  if (!config.image || config.image.trim() === "") {
    errors.push("Image must be non-empty");
  }

  // Runner type must be valid
  const validRunnerTypes: RunnerType[] = ["docker", "compose", "custom"];
  if (!validRunnerTypes.includes(config.runner)) {
    errors.push(
      `Invalid runner type: ${config.runner} (must be one of: ${validRunnerTypes.join(", ")})`
    );
  }

  // Agent type must be valid
  const validAgentTypes: AgentType[] = ["claude", "aider", "copilot-cli", "generic"];
  if (!validAgentTypes.includes(config.agentType)) {
    errors.push(
      `Invalid agent type: ${config.agentType} (must be one of: ${validAgentTypes.join(", ")})`
    );
  }

  // All volume sources must be absolute paths (after interpolation)
  config.volumes.forEach((volume: VolumeMount, index: number) => {
    if (!volume.source || volume.source.trim() === "") {
      errors.push(`Volume[${index}].source must be non-empty`);
    } else if (!isAbsolute(volume.source)) {
      errors.push(`Volume[${index}].source must be an absolute path: ${volume.source}`);
    }

    if (!volume.target || volume.target.trim() === "") {
      errors.push(`Volume[${index}].target must be non-empty`);
    }
  });

  // Validate SSH config if present
  if (config.ssh) {
    if (!config.ssh.host || config.ssh.host.trim() === "") {
      errors.push("ssh.host must be non-empty");
    }
    if (config.ssh.port !== undefined) {
      if (config.ssh.port < 1 || config.ssh.port > 65535) {
        errors.push("ssh.port must be between 1 and 65535");
      }
    }
    if (config.ssh.key_path !== undefined && !isAbsolute(config.ssh.key_path)) {
      errors.push(`ssh.key_path must be an absolute path: ${config.ssh.key_path}`);
    }
  }

  // Validate MCP config if present
  if (config.mcp) {
    config.mcp.forEach((server: McpServer, index: number) => {
      if (!server.name || server.name.trim() === "") {
        errors.push(`mcp[${index}].name must be non-empty`);
      }
      if (!server.command || server.command.trim() === "") {
        errors.push(`mcp[${index}].command must be non-empty`);
      }
    });
  }

  // Validate Git config if present
  if (config.git) {
    if (config.git.token !== undefined && config.git.token.trim() === "") {
      errors.push("git.token must be non-empty when specified");
    }
  }

  // All env var values must be strings
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value !== "string") {
      errors.push(`Environment variable '${key}' must be a string (got ${typeof value})`);
    }
  }

  return errors;
}
