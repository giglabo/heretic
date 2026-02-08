import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { readYamlFile, writeYamlFile } from "./yaml";
import type { AgentProfile, RunnerType, AgentType, ProviderType } from "../types/agent-profile";
import { getLogger } from "../logger";
import { getPathProvider } from "./profile-paths";

const logger = getLogger();

/**
 * Get the path to the agent profiles directory (~/.heretic/agents)
 */
export function getProfilesDir(): string {
  return getPathProvider().getAgentsDir();
}

/**
 * Ensure the agents directory exists
 */
export function ensureProfilesDir(): void {
  getPathProvider().ensureAgentsDir();
}

/**
 * List all available profile names
 * Returns profile names (filename without .yaml extension), sorted alphabetically
 */
export function listProfiles(): string[] {
  const profilesDir = getProfilesDir();

  if (!existsSync(profilesDir)) {
    return [];
  }

  try {
    const files = readdirSync(profilesDir);
    const profiles = files
      .filter((file) => file.endsWith(".yaml"))
      .map((file) => file.replace(/\.yaml$/, ""))
      .sort();

    return profiles;
  } catch (error) {
    logger.warn({ error }, "Failed to list profiles");
    return [];
  }
}

/**
 * Load a specific profile by name
 * Throws error if profile not found or invalid
 */
export function loadProfile(name: string): AgentProfile {
  const profilePath = join(getProfilesDir(), `${name}.yaml`);

  if (!existsSync(profilePath)) {
    throw new Error(`Profile not found: ${name}`);
  }

  try {
    const profile = readYamlFile<AgentProfile>(profilePath);

    // Validate the profile
    const errors = validateProfile(profile);
    if (errors.length > 0) {
      throw new Error(`Invalid profile '${name}': ${errors.join(", ")}`);
    }

    // Add the name if not present
    if (!profile.name) {
      profile.name = name;
    }

    return profile;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid profile")) {
      throw error;
    }
    throw new Error(
      `Failed to load profile '${name}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load all available profiles
 * Returns a map of profile name to profile object
 * Logs warnings for invalid profiles but continues loading others
 */
export function loadAllProfiles(): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();
  const profileNames = listProfiles();

  for (const name of profileNames) {
    try {
      const profile = loadProfile(name);
      profiles.set(name, profile);
    } catch (error) {
      logger.warn({ profileName: name, error }, `Skipping invalid profile: ${name}`);
    }
  }

  return profiles;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validate a profile object against the AgentProfile schema
 * Returns array of error messages (empty array = valid)
 */
export function validateProfile(profile: unknown): string[] {
  const result = validateProfileDetailed(profile);
  return result.errors;
}

/**
 * Validate a profile object with detailed errors and warnings
 * Returns both errors and warnings
 */
export function validateProfileDetailed(profile: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if profile is an object
  if (!profile || typeof profile !== "object") {
    errors.push("Profile must be an object");
    return { errors, warnings };
  }

  const p = profile as Record<string, unknown>;

  // Required field: image
  if (!p.image || typeof p.image !== "string") {
    errors.push("Profile missing required field: image");
  }

  // Required field: runner (with type validation)
  if (!p.runner) {
    errors.push("Profile missing required field: runner");
  } else if (typeof p.runner !== "string") {
    errors.push("Profile field 'runner' must be a string");
  } else {
    const validRunnerTypes: RunnerType[] = ["docker", "compose", "custom"];
    if (!validRunnerTypes.includes(p.runner as RunnerType)) {
      errors.push(`Profile field 'runner' must be one of: ${validRunnerTypes.join(", ")}`);
    }
  }

  // Optional field: agent_type (with type validation)
  if (p.agent_type !== undefined) {
    if (typeof p.agent_type !== "string") {
      errors.push("Profile field 'agent_type' must be a string");
    } else {
      const validAgentTypes: AgentType[] = ["claude", "aider", "copilot-cli", "generic"];
      if (!validAgentTypes.includes(p.agent_type as AgentType)) {
        errors.push(`Profile field 'agent_type' must be one of: ${validAgentTypes.join(", ")}`);
      }
    }
  }

  // Optional field: provider (with type validation)
  if (p.provider !== undefined) {
    if (typeof p.provider !== "string") {
      errors.push("Profile field 'provider' must be a string");
    } else {
      const validProviderTypes: ProviderType[] = ["anthropic", "thirdparty", "copilot"];
      if (!validProviderTypes.includes(p.provider as ProviderType)) {
        errors.push(`Profile field 'provider' must be one of: ${validProviderTypes.join(", ")}`);
      }
    }
  }

  // Validate volumes if present
  if (p.volumes !== undefined) {
    if (!Array.isArray(p.volumes)) {
      errors.push("Profile field 'volumes' must be an array");
    } else {
      p.volumes.forEach((volume, index) => {
        if (!volume || typeof volume !== "object") {
          errors.push(`Profile field 'volumes[${index}]' must be an object`);
          return;
        }

        const v = volume as Record<string, unknown>;

        if (!v.source || typeof v.source !== "string") {
          errors.push(`Profile field 'volumes[${index}].source' is required and must be a string`);
        }

        if (!v.target || typeof v.target !== "string") {
          errors.push(`Profile field 'volumes[${index}].target' is required and must be a string`);
        }

        if (v.readonly !== undefined && typeof v.readonly !== "boolean") {
          errors.push(`Profile field 'volumes[${index}].readonly' must be a boolean`);
        }
      });
    }
  }

  // Validate env if present
  if (p.env !== undefined) {
    if (typeof p.env !== "object" || Array.isArray(p.env)) {
      errors.push("Profile field 'env' must be an object");
    }
  }

  // Validate workdir if present
  if (p.workdir !== undefined && typeof p.workdir !== "string") {
    errors.push("Profile field 'workdir' must be a string");
  }

  // Validate command if present
  if (p.command !== undefined) {
    if (typeof p.command !== "string" && !Array.isArray(p.command)) {
      errors.push("Profile field 'command' must be a string or array");
    }
  }

  // Validate boolean fields if present
  if (p.tty !== undefined && typeof p.tty !== "boolean") {
    errors.push("Profile field 'tty' must be a boolean");
  }

  if (p.interactive !== undefined && typeof p.interactive !== "boolean") {
    errors.push("Profile field 'interactive' must be a boolean");
  }

  // Validate optional fields
  if (p.name !== undefined && typeof p.name !== "string") {
    errors.push("Profile field 'name' must be a string");
  }

  if (p.description !== undefined && typeof p.description !== "string") {
    errors.push("Profile field 'description' must be a string");
  }

  if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
    errors.push("Profile field 'enabled' must be a boolean");
  }

  // Validate extra if present
  if (p.extra !== undefined) {
    if (typeof p.extra !== "object" || Array.isArray(p.extra)) {
      errors.push("Profile field 'extra' must be an object");
    } else {
      const extra = p.extra as Record<string, unknown>;

      // Validate port mappings format
      if (extra.ports !== undefined) {
        if (!Array.isArray(extra.ports)) {
          errors.push("Profile field 'extra.ports' must be an array");
        } else {
          extra.ports.forEach((port, index) => {
            if (typeof port !== "string") {
              errors.push(`Profile field 'extra.ports[${index}]' must be a string`);
            } else {
              // Validate port format: host:container or host:container/protocol
              const portPattern = /^\d+:\d+(\/\w+)?$/;
              if (!portPattern.test(port)) {
                errors.push(
                  `Invalid port mapping format: ${port}. Must be host:container or host:container/protocol`
                );
              }
            }
          });
        }
      }
    }
  }

  // Validate ssh if present
  if (p.ssh !== undefined) {
    if (typeof p.ssh !== "object" || Array.isArray(p.ssh)) {
      errors.push("Profile field 'ssh' must be an object");
    } else {
      const ssh = p.ssh as Record<string, unknown>;
      if (!ssh.host || typeof ssh.host !== "string") {
        errors.push("Profile field 'ssh.host' is required and must be a string");
      }
      if (ssh.port !== undefined && typeof ssh.port !== "number") {
        errors.push("Profile field 'ssh.port' must be a number");
      }
      if (ssh.user !== undefined && typeof ssh.user !== "string") {
        errors.push("Profile field 'ssh.user' must be a string");
      }
      if (ssh.key_path !== undefined && typeof ssh.key_path !== "string") {
        errors.push("Profile field 'ssh.key_path' must be a string");
      }
      if (ssh.host_cwd !== undefined && typeof ssh.host_cwd !== "string") {
        errors.push("Profile field 'ssh.host_cwd' must be a string");
      }
    }
  }

  // Validate mcp if present
  if (p.mcp !== undefined) {
    if (!Array.isArray(p.mcp)) {
      errors.push("Profile field 'mcp' must be an array");
    } else {
      (p.mcp as unknown[]).forEach((server, index) => {
        if (!server || typeof server !== "object" || Array.isArray(server)) {
          errors.push(`Profile field 'mcp[${index}]' must be an object`);
          return;
        }
        const s = server as Record<string, unknown>;
        if (!s.name || typeof s.name !== "string") {
          errors.push(`Profile field 'mcp[${index}].name' is required and must be a string`);
        }
        if (!s.command || typeof s.command !== "string") {
          errors.push(`Profile field 'mcp[${index}].command' is required and must be a string`);
        }
        if (s.args !== undefined && !Array.isArray(s.args)) {
          errors.push(`Profile field 'mcp[${index}].args' must be an array`);
        }
        if (s.env !== undefined && (typeof s.env !== "object" || Array.isArray(s.env))) {
          errors.push(`Profile field 'mcp[${index}].env' must be an object`);
        }
      });
    }
  }

  // Validate mcp_file if present
  if (p.mcp_file !== undefined) {
    if (typeof p.mcp_file !== "string" || p.mcp_file.trim() === "") {
      errors.push("Profile field 'mcp_file' must be a non-empty string");
    }
  }

  // Validate mcp_override if present
  if (p.mcp_override !== undefined && typeof p.mcp_override !== "boolean") {
    errors.push("Profile field 'mcp_override' must be a boolean");
  }

  // Validate git if present
  if (p.git !== undefined) {
    if (typeof p.git !== "object" || Array.isArray(p.git)) {
      errors.push("Profile field 'git' must be an object");
    } else {
      const git = p.git as Record<string, unknown>;
      if (git.token !== undefined && typeof git.token !== "string") {
        errors.push("Profile field 'git.token' must be a string");
      }
      if (git.author_name !== undefined && typeof git.author_name !== "string") {
        errors.push("Profile field 'git.author_name' must be a string");
      }
      if (git.author_email !== undefined && typeof git.author_email !== "string") {
        errors.push("Profile field 'git.author_email' must be a string");
      }
    }
  }

  // Validate dind if present
  if (p.dind !== undefined && typeof p.dind !== "boolean") {
    errors.push("Profile field 'dind' must be a boolean");
  }

  // Validate secrets if present
  if (p.secrets !== undefined) {
    if (typeof p.secrets !== "object" || Array.isArray(p.secrets) || p.secrets === null) {
      errors.push("Profile field 'secrets' must be an object");
    } else {
      for (const [key, value] of Object.entries(p.secrets)) {
        if (typeof value !== "string") {
          errors.push(`Profile field 'secrets.${key}' must be a string (script path)`);
        } else if (value.trim() === "") {
          errors.push(`Profile field 'secrets.${key}' must not be empty`);
        }
      }
    }
  }

  // Warning: compose section only valid when runner is "compose"
  if (p.compose !== undefined && p.runner !== "compose") {
    warnings.push(
      `compose section present but runner is "${p.runner || "docker"}". Compose config will be ignored.`
    );
  }

  return { errors, warnings };
}

/**
 * Save a profile to disk
 */
export function saveProfile(name: string, profile: AgentProfile): void {
  ensureProfilesDir();

  const profilePath = join(getProfilesDir(), `${name}.yaml`);

  try {
    writeYamlFile(profilePath, profile);
    logger.debug({ profileName: name, profilePath }, "Profile saved");
  } catch (error) {
    throw new Error(
      `Failed to save profile '${name}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
