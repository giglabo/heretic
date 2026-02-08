import { spawn } from "node:child_process";
import { getLogger, logRaw } from "../logger";
import { isDockerAvailable, listContainers, getDockerClient } from "../utils/docker";
import type { ContainerInfo } from "dockerode";

/**
 * Find container by name or ID prefix
 */
function findContainerByNameOrId(
  nameOrId: string,
  containers: ContainerInfo[]
): ContainerInfo | undefined {
  return containers.find((container) => {
    // Check if container ID starts with the provided prefix
    if (container.Id.startsWith(nameOrId)) {
      return true;
    }

    // Check if any container name matches (strip leading '/')
    return container.Names.some((name) => {
      const cleanName = name.replace(/^\//, "");
      return cleanName === nameOrId || cleanName.includes(nameOrId);
    });
  });
}

/**
 * Attach to a running heretic container
 */
export async function runAttach(name: string, options?: { session?: string }): Promise<void> {
  const logger = getLogger();

  // Check Docker availability
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    logger.error("Docker is not running or not available");
    process.exit(1);
  }

  try {
    const docker = getDockerClient();

    // Build label filters
    const labelFilters = ["heretic.managed=true"];
    if (options?.session) {
      labelFilters.push(`heretic.session=${options.session}`);
    }

    // List all heretic containers
    const containers = await listContainers(docker, {
      all: true,
      filters: JSON.stringify({
        label: labelFilters,
      }),
    });

    if (containers.length === 0) {
      logger.error("No heretic containers found");
      process.exit(1);
    }

    // Find the container by name or ID
    const containerInfo = findContainerByNameOrId(name, containers);
    if (!containerInfo) {
      logger.error({ name }, `Container '${name}' not found`);
      process.exit(1);
    }

    // Verify container is running
    if (containerInfo.State !== "running") {
      logger.error(
        { name, state: containerInfo.State },
        `Container '${name}' is not running (state: ${containerInfo.State})`
      );
      process.exit(1);
    }

    const containerName =
      containerInfo.Names[0]?.replace(/^\//, "") || containerInfo.Id.substring(0, 12);
    logger.info({ name: containerName }, `Attaching to ${containerName}...`);
    logRaw(`Attached to ${containerName}. Press Ctrl+P, Ctrl+Q to detach.`);

    // Use docker attach command directly - more reliable for interactive TTY
    const dockerAttach = spawn("docker", ["attach", containerInfo.Id], {
      stdio: "inherit",
    });

    dockerAttach.on("error", (err) => {
      logger.error({ error: err }, "Failed to attach to container");
      process.exit(1);
    });

    dockerAttach.on("close", (code) => {
      logger.debug({ exitCode: code }, "Detached from container");
      process.exit(code ?? 0);
    });
  } catch (error) {
    logger.error({ error }, "Failed to attach to container");
    process.exit(1);
  }
}
