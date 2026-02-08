/**
 * Run Agent Command
 *
 * Main command for starting an agent container in the current directory.
 * Resolves configuration, creates a runner, and starts the container.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveConfig } from "../utils/config-resolver";
import { createRunner } from "../runners";
import type { McpServer } from "../types/agent-profile";
import { getLogger } from "../logger";

/**
 * Run an agent by name with optional CLI overrides
 *
 * @param agentName - Name of the agent profile to run
 * @param options - Runtime options
 * @param options.detach - Run container in background (detached mode)
 * @param options.command - Override the default command specified in config
 */
/**
 * Parse --mcp value: if it's a file path that exists, read and parse it;
 * otherwise parse as JSON string.
 */
function parseMcpOption(value: string): McpServer[] {
  let raw: string;
  if (existsSync(value)) {
    raw = readFileSync(value, "utf-8");
  } else {
    raw = value;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("MCP config must be a JSON array of server objects");
  }
  return parsed as McpServer[];
}

export async function runAgent(
  agentName: string,
  options: { detach?: boolean; command?: string[]; mcp?: string; session?: string }
): Promise<void> {
  const logger = getLogger();
  const { detach = false, command, mcp, session } = options;

  try {
    // Parse --mcp override if provided
    const cliOverrides: Record<string, unknown> = {};
    if (mcp) {
      try {
        cliOverrides.mcp = parseMcpOption(mcp);
      } catch (error) {
        logger.error(
          `Invalid --mcp value: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
        return;
      }
    }

    // Resolve configuration
    logger.info(`Resolving config for '${agentName}'...`);
    const resolvedConfig = resolveConfig({
      profileName: agentName,
      projectDir: process.cwd(),
      cliOverrides,
      sessionName: session,
    });

    // Log config sources
    logger.info(`Using global profile: ${agentName}`);
    // Note: config-resolver logs local override presence automatically if detected

    // Create runner
    const runner = createRunner(resolvedConfig);

    // Start the container
    logger.info(`Starting agent '${agentName}'...`);
    const result = await runner.start({ detach, command });

    if (detach) {
      // Detached mode: log container ID and exit
      logger.info(`Container started in detached mode`);
      logger.info(`Container ID: ${result.containerId}`);
      logger.info(`Run 'heretic attach ${result.containerId}' to attach to this container`);
    } else {
      // Interactive mode: container has exited
      if (result.exitCode !== undefined) {
        if (result.exitCode !== 0) {
          // Use info level - non-zero exit is normal for interactive sessions
          logger.info(`Container exited with code ${result.exitCode}`);
        }
        // Set process exit code to match container exit code
        process.exitCode = result.exitCode;
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      // Handle specific error cases with user-friendly messages
      if (error.message.includes("Profile not found")) {
        logger.error(`Profile '${agentName}' not found.`);
        logger.info(`Run 'heretic agents list' to see available profiles.`);
        process.exitCode = 1;
        return;
      }

      if (error.message.includes("Docker is not available")) {
        logger.error("Docker is not available. Start Docker and try again.");
        process.exitCode = 1;
        return;
      }

      // Generic error handler
      logger.error(`Failed to run agent '${agentName}': ${error.message}`);
    } else {
      logger.error(`Failed to run agent '${agentName}': ${String(error)}`);
    }
    process.exitCode = 1;
  }
}
