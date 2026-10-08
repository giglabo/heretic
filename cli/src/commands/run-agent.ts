/**
 * Run Agent Command
 *
 * Main command for starting an agent container in the current directory.
 * Resolves configuration, creates a runner, and starts the container.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveConfig } from "../utils/config-resolver";
import { createRunner } from "../runners";
import type {
  AgentProfileExtra,
  BuildSidecar,
  McpServer,
  ResolvedAgentConfig,
  SidecarRuntime,
} from "../types/agent-profile";
import { dropBusyOptionalPorts, formatPortMappings } from "../utils/ports";
import {
  findContainerByName,
  isContainerActive,
  removeContainer,
  stopContainer,
} from "../utils/docker";
import { attachToContainer, ownsSessionContainer } from "../utils/container-reuse";
import { getAgentContainerName } from "../utils/session";
import { getLogger, logRaw } from "../logger";

/**
 * Run an agent by name with optional CLI overrides
 *
 * @param agentName - Name of the agent profile to run
 * @param options - Runtime options
 * @param options.detach - Run container in background (detached mode)
 * @param options.command - Override the default command specified in config
 * @param options.recreate - Replace this session's container instead of reusing it
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

/**
 * Parse repeatable `--builder-image <runtime>=<image>` values into a map.
 * Throws on a malformed entry so the user gets a clear error, not silent drop.
 */
function parseBuilderImages(values: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of values || []) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(`--builder-image expects <runtime>=<image>, got '${raw}'`);
    }
    map[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim();
  }
  return map;
}

/** Default builder image name for a runtime when none is supplied. */
function defaultBuilderImage(runtime: string): string {
  return `heretic-builder-${runtime}:latest`;
}

/**
 * Skip preset ports whose host port is already taken (a local dev server, a
 * database, another agent with the same preset), so one busy port doesn't stop
 * the container. Explicit ports stay; Docker reports their conflicts.
 */
async function skipBusyPresetPorts(config: ResolvedAgentConfig): Promise<void> {
  const logger = getLogger();
  if (!config.portMappings?.length || config.runner === "custom") return;

  const { kept, dropped } = await dropBusyOptionalPorts(config.portMappings);
  if (dropped.length > 0) {
    logger.warn(
      `Skipping preset ports already in use on the host: ${formatPortMappings(dropped).join(", ")}`
    );
  }
  config.portMappings = kept;
  config.extra.ports = formatPortMappings(kept);
  if (kept.length > 0) {
    logger.info(`Publishing ${kept.length} port(s): ${config.extra.ports.join(", ")}`);
  }
}

/**
 * Deal with a session that is already live in this folder (same profile +
 * session). By default `run` attaches to it instead of starting another one —
 * the runners would otherwise replace the same-named container and kill the
 * agent working there. `--recreate` removes it so a fresh one is created.
 *
 * @returns "continue" to go on and start the runner (nothing live, or it was
 *          removed for --recreate), "done" when handled here (attached, or
 *          already running detached), "error" when refused.
 */
async function handleLiveSession(
  agentName: string,
  config: ResolvedAgentConfig,
  options: { detach: boolean; command?: string[]; recreate: boolean }
): Promise<"continue" | "done" | "error"> {
  // The custom runner names containers from the user's compose file.
  if (config.runner === "custom") return "continue";

  const logger = getLogger();
  const containerName = getAgentContainerName(config.name, config.sessionName, config.projectDir);
  let existing;
  try {
    existing = await findContainerByName(containerName);
  } catch {
    return "continue"; // the runner reports Docker problems itself
  }
  if (!existing || !isContainerActive(existing)) return "continue";

  if (!ownsSessionContainer(existing.Labels, config)) {
    logger.error(
      `Container '${containerName}' is running but belongs to another profile, folder or session.`
    );
    logger.info(`Use another session name: heretic-cli run ${agentName} -s <name>`);
    return "error";
  }

  if (options.recreate) {
    logger.warn(
      `Recreating session '${config.sessionName}' of '${agentName}': stopping the running container ${containerName}`
    );
    await stopContainer(existing.Id, { t: 5 }).catch(() => undefined);
    await removeContainer(existing.Id, { force: true });
    return "continue";
  }

  if (options.command) {
    logger.error(
      `Agent '${agentName}' is already running in this folder in session '${config.sessionName}'; a custom command needs a new container.`
    );
    logger.info(`Run it in another session: heretic-cli run ${agentName} -s <name> ...`);
    logger.info(`Or replace the running one: heretic-cli run ${agentName} --recreate ...`);
    return "error";
  }

  if (options.detach) {
    logger.info(
      `Agent '${agentName}' is already running in session '${config.sessionName}' (${containerName}).`
    );
    logger.info(`Attach to it: heretic-cli attach ${agentName} -s ${config.sessionName}`);
    return "done";
  }

  logger.info(
    `Attaching to running session '${config.sessionName}' (${containerName}); pass --recreate for a fresh container.`
  );
  logRaw(`Attached to ${containerName}. Press Ctrl+P, Ctrl+Q to detach.`);
  const exitCode = await attachToContainer(existing.Id);
  if (exitCode !== undefined && exitCode !== 0) {
    logger.info(`Container exited with code ${exitCode}`);
    process.exitCode = exitCode;
  }
  return "done";
}

export async function runAgent(
  agentName: string,
  options: {
    detach?: boolean;
    command?: string[];
    recreate?: boolean;
    mcp?: string;
    session?: string;
    asRoot?: boolean;
    sidecar?: string[];
    builderImage?: string[];
    disableSidecars?: boolean;
    port?: string[];
    portPreset?: string[];
    portHostIp?: string;
    portOffset?: string;
    ports?: boolean;
  }
): Promise<void> {
  const logger = getLogger();
  const {
    detach = false,
    command,
    recreate = false,
    mcp,
    session,
    asRoot,
    sidecar,
    builderImage,
    disableSidecars,
    port,
    portPreset,
    portHostIp,
    portOffset,
    ports,
  } = options;

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

    // --root override: only set when explicitly passed so it never clobbers
    // a profile's run_as_root value when the flag is absent.
    const extraOverrides: AgentProfileExtra = {};
    if (asRoot) {
      extraOverrides.run_as_root = true;
    }

    // --no-ports drops the profile's ports and presets; --port / --port-preset
    // given on the same command line still apply.
    if (ports === false) {
      extraOverrides.ports = [];
      extraOverrides.port_presets = [];
    }
    if (portHostIp !== undefined) {
      extraOverrides.ports_host_ip = portHostIp;
    }
    if (portOffset !== undefined) {
      const offset = Number(portOffset);
      if (!Number.isInteger(offset)) {
        logger.error(`--port-offset expects an integer, got '${portOffset}'`);
        process.exitCode = 1;
        return;
      }
      extraOverrides.ports_offset = offset;
    }
    if (Object.keys(extraOverrides).length > 0) {
      cliOverrides.extra = extraOverrides;
    }

    // --sidecar / --disable-sidecars: build a tool_backends override.
    // --sidecar replaces the profile's sidecar list (one-off), defaulting each
    // runtime's image to heretic-builder-<runtime>:latest unless overridden by
    // --builder-image. --disable-sidecars turns them all off for this run.
    let builderImages: Record<string, string> = {};
    try {
      builderImages = parseBuilderImages(builderImage);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    if (disableSidecars) {
      cliOverrides.tool_backends = { sidecars: [] };
    } else if (sidecar && sidecar.length > 0) {
      const sidecars: BuildSidecar[] = sidecar.map((rt) => ({
        runtime: rt as SidecarRuntime,
        image: builderImages[rt] ?? defaultBuilderImage(rt),
      }));
      cliOverrides.tool_backends = { sidecars };
    }

    // Resolve configuration
    logger.info(`Resolving config for '${agentName}'...`);
    const resolvedConfig = resolveConfig({
      profileName: agentName,
      projectDir: process.cwd(),
      cliOverrides,
      sessionName: session,
      addPorts: port,
      addPortPresets: portPreset,
    });

    const live = await handleLiveSession(agentName, resolvedConfig, { detach, command, recreate });
    if (live !== "continue") {
      if (live === "error") process.exitCode = 1;
      return;
    }

    await skipBusyPresetPorts(resolvedConfig);

    // Apply --builder-image overrides to the resolved sidecars. This also
    // targets profile-declared sidecars (the "bring-your-own-builder" on-ramp),
    // not just those introduced by --sidecar. Image strings can't introduce an
    // invalid runtime, so no re-validation is required.
    if (Object.keys(builderImages).length > 0 && resolvedConfig.toolBackends?.sidecars) {
      for (const sc of resolvedConfig.toolBackends.sidecars) {
        if (builderImages[sc.runtime]) {
          sc.image = builderImages[sc.runtime];
        }
      }
    }

    // Build sidecars are orchestrated natively by both the docker runner
    // (dockerode-native SidecarManager) and the compose runner. Only the custom
    // runner can't manage siblings.
    if (resolvedConfig.toolBackends?.sidecars?.length && resolvedConfig.runner === "custom") {
      logger.error(
        "Build sidecars require the 'docker' or 'compose' runner, but this profile uses the custom runner."
      );
      process.exitCode = 1;
      return;
    }

    // Log config sources
    logger.info(`Using global profile: ${agentName}`);
    // Note: config-resolver logs local override presence automatically if detected

    // Create runner
    const runner = createRunner(resolvedConfig);

    // Start the container
    logger.info(`Starting agent '${agentName}'...`);
    const result = await runner.start({ detach, command, recreate });

    if (detach) {
      // Detached mode: log container ID and exit
      logger.info(`Container started in detached mode`);
      logger.info(`Container ID: ${result.containerId}`);
      logger.info(`Run 'heretic-cli attach ${result.containerId}' to attach to this container`);
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
        logger.info(`Run 'heretic-cli agents list' to see available profiles.`);
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
