import { join, dirname, basename } from "path";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { readYamlFile, writeYamlFile } from "./yaml";
import type { LocalOverride } from "../types/agent-profile";
import { getLogger } from "../logger";

const logger = getLogger();

/** Files in .heretic/cli/ that are not per-profile configs */
const RESERVED_FILENAMES = new Set(["compose.yaml", "claude-settings.json"]);

/**
 * Get the legacy local config path (.heretic/cli/agent.yaml)
 */
function getLegacyConfigPath(projectDir: string): string {
  return join(projectDir, ".heretic", "cli", "agent.yaml");
}

/**
 * Get the path to a per-profile local config file
 * @param projectDir - Project directory
 * @param profileName - Profile name (optional for backward compat)
 * @returns Path to .heretic/cli/{profileName}.yaml or legacy .heretic/cli/agent.yaml
 */
export function getLocalConfigPath(projectDir: string, profileName?: string): string {
  if (profileName) {
    return join(projectDir, ".heretic", "cli", `${profileName}.yaml`);
  }
  // Legacy fallback
  return getLegacyConfigPath(projectDir);
}

/**
 * Get the path to the local compose file
 * @param projectDir - Project directory
 * @returns Path to .heretic/cli/compose.yaml
 */
export function getLocalComposePath(projectDir: string): string {
  return join(projectDir, ".heretic", "cli", "compose.yaml");
}

/**
 * Check if a local agent config file exists for a given profile.
 * Checks per-profile file first, then falls back to legacy agent.yaml
 * if its `extends` field matches the profileName.
 * @param projectDir - Project directory
 * @param profileName - Profile name (optional for backward compat)
 * @returns True if a matching local config exists
 */
export function hasLocalConfig(projectDir: string, profileName?: string): boolean {
  if (profileName) {
    // Check per-profile file first
    const perProfilePath = getLocalConfigPath(projectDir, profileName);
    if (existsSync(perProfilePath)) {
      return true;
    }

    // Fall back to legacy agent.yaml if its extends matches
    const legacyPath = getLegacyConfigPath(projectDir);
    if (existsSync(legacyPath)) {
      try {
        const config = readYamlFile<LocalOverride>(legacyPath);
        return config?.extends === profileName;
      } catch {
        return false;
      }
    }

    return false;
  }

  // No profileName — legacy behavior: check agent.yaml
  return existsSync(getLegacyConfigPath(projectDir));
}

/**
 * Check if a local compose file exists
 * @param projectDir - Project directory
 * @returns True if .heretic/compose.yaml exists
 */
export function hasLocalCompose(projectDir: string): boolean {
  const composePath = getLocalComposePath(projectDir);
  return existsSync(composePath);
}

/**
 * Load and parse a local agent config file.
 * For per-profile files, the `extends` field is inferred from the filename.
 * Falls back to legacy agent.yaml if per-profile file doesn't exist.
 * @param projectDir - Project directory
 * @param profileName - Profile name (optional for backward compat)
 * @returns Parsed LocalOverride object
 * @throws Error if file doesn't exist or YAML is invalid
 */
export function loadLocalConfig(projectDir: string, profileName?: string): LocalOverride {
  let configPath: string;

  if (profileName) {
    // Try per-profile file first
    const perProfilePath = getLocalConfigPath(projectDir, profileName);
    if (existsSync(perProfilePath)) {
      configPath = perProfilePath;
    } else {
      // Fall back to legacy agent.yaml
      configPath = getLegacyConfigPath(projectDir);
    }
  } else {
    configPath = getLegacyConfigPath(projectDir);
  }

  if (!existsSync(configPath)) {
    throw new Error(`Local config file not found: ${configPath}`);
  }

  logger.debug(`Loading local config from ${configPath}`);

  try {
    const config = readYamlFile<LocalOverride>(configPath);

    if (!config || typeof config !== "object") {
      throw new Error("Invalid config: expected an object");
    }

    // For per-profile files, infer extends from filename if not set
    if (profileName && !config.extends) {
      config.extends = profileName;
    }

    if (!config.extends || typeof config.extends !== "string") {
      throw new Error("Invalid config: 'extends' field is required and must be a string");
    }

    logger.debug(`Loaded local config extending profile: ${config.extends}`);
    return config;
  } catch (error) {
    if (error instanceof Error && error.message.includes("'extends' field")) {
      throw error;
    }
    throw new Error(
      `Failed to load local config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save a local agent config file
 * Creates the .heretic/cli/ directory if needed
 * @param projectDir - Project directory
 * @param config - Local override configuration to save
 * @param profileName - Profile name (optional for backward compat)
 */
export function saveLocalConfig(
  projectDir: string,
  config: LocalOverride,
  profileName?: string
): void {
  const configPath = getLocalConfigPath(projectDir, profileName);
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeYamlFile(configPath, config);
  logger.debug(`Saved local config to ${configPath}`);
}

/**
 * List all local config profile names in a project directory.
 * Scans .heretic/cli/*.yaml for per-profile files and checks legacy agent.yaml.
 * @param projectDir - Project directory
 * @returns Array of profile names that have local overrides
 */
export function listLocalConfigs(projectDir: string): string[] {
  const cliDir = join(projectDir, ".heretic", "cli");
  const profiles = new Set<string>();

  if (!existsSync(cliDir)) {
    return [];
  }

  try {
    const files = readdirSync(cliDir);
    for (const file of files) {
      // Skip reserved filenames and non-yaml files
      if (RESERVED_FILENAMES.has(file)) continue;
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;

      const name = basename(file, file.endsWith(".yml") ? ".yml" : ".yaml");

      if (name === "agent") {
        // Legacy agent.yaml — read extends field to get profile name
        try {
          const config = readYamlFile<LocalOverride>(join(cliDir, file));
          if (config?.extends) {
            profiles.add(config.extends);
          }
        } catch {
          // Skip invalid files
        }
      } else {
        profiles.add(name);
      }
    }
  } catch {
    // Directory read failed
  }

  return Array.from(profiles);
}
