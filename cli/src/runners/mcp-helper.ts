/**
 * MCP Helper
 *
 * Generates and manages .mcp.json files for MCP server configuration
 * inside agent containers.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { McpServer, AgentType } from "../types/agent-profile";
import { getLogger } from "../logger";

const logger = getLogger();

/**
 * Get the container paths where MCP config should be mounted based on agent type
 *
 * @param agentType - The type of agent (claude, aider, copilot-cli, generic)
 * @returns Array of container paths for MCP config
 */
export function getMcpMountPaths(agentType: AgentType): string[] {
  switch (agentType) {
    case "copilot-cli":
      // Copilot CLI expects mcp-config.json in ~/.copilot/
      // Mount to both /root and /home/agent for different container users
      return ["/root/.copilot/mcp-config.json", "/home/agent/.copilot/mcp-config.json"];
    case "claude":
      // Claude Code expects .mcp.json in the workspace root
      return ["/workspace/.mcp.json"];
    case "aider":
      // Aider - for future implementation
      return ["/workspace/.mcp.json"];
    case "generic":
    default:
      // Generic agents use workspace root
      return ["/workspace/.mcp.json"];
  }
}

/**
 * Get the path to check for existing MCP config in the workspace
 *
 * @param agentType - The type of agent
 * @param projectDir - Absolute path to the project directory
 * @returns Absolute path to the existing MCP config file to check
 */
export function getExistingMcpPath(agentType: AgentType, projectDir: string): string {
  switch (agentType) {
    case "copilot-cli":
      // Copilot CLI uses .copilot/mcp-config.json in the project
      return join(projectDir, ".copilot", "mcp-config.json");
    default:
      return join(projectDir, ".mcp.json");
  }
}

/**
 * Write MCP server configuration to a temp .mcp.json file.
 *
 * When sessionDir is provided, writes to `<sessionDir>/.mcp.json`.
 * Otherwise falls back to `.heretic/cli/temp/.mcp.json` in the project.
 *
 * @param projectDir - Absolute path to the project directory
 * @param mcpServers - Array of MCP server configurations
 * @param sessionDir - Optional session directory to write into
 * @returns Absolute path to the generated .mcp.json file
 */
export function writeMcpFile(
  projectDir: string,
  mcpServers: McpServer[],
  sessionDir?: string,
  agentType?: AgentType
): string {
  const filepath = sessionDir
    ? join(sessionDir, ".mcp.json")
    : join(projectDir, ".heretic", "cli", "temp", ".mcp.json");

  // Ensure .heretic/cli/temp/ directory exists
  const dir = dirname(filepath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Build the MCP JSON structure
  const mcpConfig: Record<string, unknown> = {
    mcpServers: {} as Record<string, unknown>,
  };

  const servers = mcpConfig.mcpServers as Record<string, unknown>;
  for (const server of mcpServers) {
    const entry: Record<string, unknown> = {
      command: server.command,
    };
    if (server.args && server.args.length > 0) {
      entry.args = server.args;
    }
    if (server.env && Object.keys(server.env).length > 0) {
      entry.env = server.env;
    }
    // Copilot CLI requires type and tools fields on every server entry
    if (agentType === "copilot-cli") {
      entry.type = "stdio";
      entry.tools = ["*"];
    }
    servers[server.name] = entry;
  }

  writeFileSync(filepath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  logger.debug({ filepath, agentType }, "Wrote MCP config file");

  return filepath;
}

/**
 * Remove an MCP config file if it exists
 *
 * @param filepath - Absolute path to the .mcp.json file to remove
 */
export function cleanupMcpFile(filepath: string): void {
  if (existsSync(filepath)) {
    try {
      unlinkSync(filepath);
      logger.debug({ filepath }, "Cleaned up MCP config file");
    } catch (error) {
      logger.debug({ error, filepath }, "Failed to cleanup MCP config file");
    }
  }
}

/**
 * Parse an already-parsed JSON object into McpServer array.
 *
 * Auto-detects three formats:
 * - `{ "mcpServers": { ... } }` — Claude/Copilot CLI format
 * - `{ "servers": { ... } }` — VS Code format
 * - `{ "name": { "command": ... } }` — bare server map
 *
 * @param parsed - Already-parsed JSON object
 * @param source - Optional label for error messages (default: "input")
 * @returns Array of McpServer objects
 * @throws Error if input is invalid or contains invalid entries
 */
export function parseMcpJson(parsed: unknown, source?: string): McpServer[] {
  const label = source || "input";

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP ${label} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // Auto-detect format
  let serversMap: Record<string, unknown>;
  if (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)) {
    serversMap = obj.mcpServers as Record<string, unknown>;
    logger.debug({ source: label }, "Detected mcpServers (Claude/Copilot CLI) format");
  } else if (obj.servers && typeof obj.servers === "object" && !Array.isArray(obj.servers)) {
    serversMap = obj.servers as Record<string, unknown>;
    logger.debug({ source: label }, "Detected servers (VS Code) format");
  } else {
    serversMap = obj;
    logger.debug({ source: label }, "Detected bare server map format");
  }

  return convertServersMap(serversMap, label);
}

/**
 * Load MCP server definitions from a JSON file.
 *
 * Auto-detects three formats:
 * - `{ "mcpServers": { ... } }` — Claude/Copilot CLI format
 * - `{ "servers": { ... } }` — VS Code format
 * - `{ "name": { "command": ... } }` — bare server map
 *
 * @param filePath - Path to the JSON file (supports ~ expansion)
 * @returns Array of McpServer objects
 * @throws Error if file cannot be read, parsed, or contains invalid entries
 */
export function loadMcpFromFile(filePath: string): McpServer[] {
  // Expand ~ to home directory
  const expandedPath = filePath.startsWith("~")
    ? resolve(join(homedir(), filePath.slice(1)))
    : resolve(filePath);

  if (!existsSync(expandedPath)) {
    throw new Error(`MCP file not found: ${expandedPath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(expandedPath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read MCP file: ${expandedPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse MCP file as JSON: ${expandedPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parseMcpJson(parsed, expandedPath);
}

/**
 * Convert a keyed server map to McpServer array
 */
function convertServersMap(serversMap: Record<string, unknown>, filePath: string): McpServer[] {
  const servers: McpServer[] = [];

  for (const [name, entry] of Object.entries(serversMap)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`MCP server '${name}' in ${filePath} must be an object`);
    }

    const serverEntry = entry as Record<string, unknown>;

    if (!serverEntry.command || typeof serverEntry.command !== "string") {
      throw new Error(`MCP server '${name}' in ${filePath} is missing required field 'command'`);
    }

    const server: McpServer = {
      name,
      command: serverEntry.command,
    };

    if (Array.isArray(serverEntry.args)) {
      server.args = serverEntry.args as string[];
    }

    if (serverEntry.env && typeof serverEntry.env === "object" && !Array.isArray(serverEntry.env)) {
      server.env = serverEntry.env as Record<string, string>;
    }

    servers.push(server);
  }

  return servers;
}
