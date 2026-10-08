import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { readYamlFile, writeYamlFile } from "./yaml";
import { getPathProvider } from "./profile-paths";
import type { HereticSettings, AgentConfig } from "../types";
import { getLogger } from "../logger";

/**
 * Get the path to the settings file (~/.heretic/settings.yaml)
 */
export function getSettingsPath(): string {
  return getPathProvider().getSettingsPath();
}

/**
 * Get the path to the .heretic directory
 */
export function getHereticDir(): string {
  return getPathProvider().getHereticDir();
}

/**
 * Ensure the .heretic directory exists
 */
export function ensureSettingsDir(): void {
  const hereticDir = getHereticDir();
  if (!existsSync(hereticDir)) {
    mkdirSync(hereticDir, { recursive: true });
  }
}

/**
 * Load existing settings from ~/.heretic/settings.yaml
 * Returns empty object if file doesn't exist
 */
export function loadSettings(): HereticSettings {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const settings = readYamlFile<HereticSettings>(settingsPath);
    return settings || {};
  } catch {
    // If file is corrupted or invalid, return empty settings
    return {};
  }
}

/**
 * Save settings to ~/.heretic/settings.yaml
 */
export function saveSettings(settings: HereticSettings): void {
  ensureSettingsDir();
  const settingsPath = getSettingsPath();
  writeYamlFile(settingsPath, settings);
}

/**
 * Deep merge settings, preserving existing values not being updated
 * For agents array: merges by name, preserves agents not being updated
 */
export function mergeSettings(
  existing: HereticSettings,
  updates: Partial<HereticSettings>
): HereticSettings {
  const merged: HereticSettings = { ...existing };

  // Merge github config
  if (updates.github) {
    merged.github = {
      ...existing.github,
      ...updates.github,
    };
  }

  // Merge agents array
  if (updates.agents) {
    const existingAgents = existing.agents || [];
    const updatedAgents = updates.agents;

    // Create a map of existing agents by name for quick lookup
    const agentMap = new Map<string, AgentConfig>();
    existingAgents.forEach((agent) => agentMap.set(agent.name, agent));

    // Update or add agents from updates
    updatedAgents.forEach((updatedAgent) => {
      agentMap.set(updatedAgent.name, updatedAgent);
    });

    // Convert back to array
    merged.agents = Array.from(agentMap.values());
  }

  return merged;
}

/**
 * Find an agent by name
 */
export function findAgent(settings: HereticSettings, name: string): AgentConfig | undefined {
  return settings.agents?.find((agent) => agent.name === name);
}

/**
 * Remove an agent by name
 */
export function removeAgent(settings: HereticSettings, name: string): HereticSettings {
  return {
    ...settings,
    agents: settings.agents?.filter((agent) => agent.name !== name) || [],
  };
}

/**
 * Get all agents of a specific type
 */
export function getAgentsByType(
  settings: HereticSettings,
  type: "anthropic" | "thirdparty" | "copilot"
): AgentConfig[] {
  return settings.agents?.filter((agent) => agent.type === type) || [];
}

/**
 * Mask a token for display purposes
 * Shows first 8 characters and last 4 characters
 */
export function maskToken(token: string): string {
  if (!token || token.length < 12) {
    return "****";
  }
  const start = token.substring(0, 8);
  const end = token.substring(token.length - 4);
  return `${start}****${end}`;
}

/**
 * Check if a value looks like a script path (ends with .sh, .cmd, .ps1, or .bat)
 */
export function isScriptPath(value: string): boolean {
  return /\.(sh|cmd|ps1|bat)$/i.test(value.trim());
}

/**
 * Resolve a token value - if it's a script path, execute the script
 * and return the output. If it's a raw value, return as-is.
 * Supports both Unix (.sh) and Windows (.cmd, .bat, .ps1) scripts.
 */
export function resolveToken(tokenOrScript: string): string {
  const logger = getLogger();

  if (!isScriptPath(tokenOrScript)) {
    // Raw token value (backward compatibility)
    return tokenOrScript;
  }

  // Expand ~ to home directory
  let scriptPath = tokenOrScript.trim();
  if (scriptPath.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    scriptPath = scriptPath.replace("~", home);
  }

  if (!existsSync(scriptPath)) {
    logger.warn({ scriptPath }, "Token script not found, using raw value");
    return tokenOrScript;
  }

  try {
    const output = execSync(`"${scriptPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      shell: true,
    });
    return output.trim();
  } catch (error) {
    logger.error({ error, scriptPath }, "Failed to execute token script");
    throw new Error(`Failed to resolve token from script: ${scriptPath}`);
  }
}
