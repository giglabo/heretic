import inquirer from "inquirer";
import { getLogger, logRaw } from "../logger";
import {
  isDockerAvailable,
  listContainers,
  getDockerClient,
  stopContainer,
  removeContainer,
} from "../utils/docker";
import {
  SIDECAR_ROLE_LABEL,
  SIDECAR_ROLE_VALUE,
  removeNetworkByName,
} from "../runners/sidecar-manager";
import type { ContainerInfo } from "dockerode";

/** True when a container is a heretic-managed build sidecar (not an agent). */
function isSidecar(container: ContainerInfo): boolean {
  return container.Labels?.[SIDECAR_ROLE_LABEL] === SIDECAR_ROLE_VALUE;
}

/**
 * Find the build-sidecar containers that belong to a given agent container
 * (same project, and same session when the agent has one).
 */
function siblingSidecars(agent: ContainerInfo, all: ContainerInfo[]): ContainerInfo[] {
  const project = agent.Labels?.["heretic.project"];
  const session = agent.Labels?.["heretic.session"];
  return all.filter(
    (c) =>
      isSidecar(c) &&
      c.Labels?.["heretic.project"] === project &&
      (!session || c.Labels?.["heretic.session"] === session)
  );
}

interface StopOptions {
  all?: boolean;
  force?: boolean;
  keep?: boolean;
  session?: string;
}

/**
 * Find container by name or ID prefix
 */
async function findContainerByNameOrId(
  nameOrId: string,
  containers: ContainerInfo[]
): Promise<ContainerInfo | undefined> {
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
 * Find container associated with current directory (optionally filtered by session)
 */
async function findContainerByProject(
  projectDir: string,
  containers: ContainerInfo[],
  session?: string
): Promise<ContainerInfo | undefined> {
  return containers.find((container) => {
    const projectLabel = container.Labels?.["heretic.project"];
    if (projectLabel !== projectDir) return false;
    if (session) {
      const sessionLabel = container.Labels?.["heretic.session"];
      return sessionLabel === session;
    }
    return true;
  });
}

/**
 * Stop a single container
 */
async function stopSingleContainer(
  container: ContainerInfo,
  options: { keep?: boolean }
): Promise<void> {
  const logger = getLogger();
  const docker = getDockerClient();
  const name = container.Names[0]?.replace(/^\//, "") || container.Id.substring(0, 12);

  try {
    // Check if container is already stopped
    if (container.State === "exited" || container.State === "dead") {
      logger.debug({ name, state: container.State }, "Container already stopped");
      logRaw(`Container ${name} is already stopped`);

      if (!options.keep) {
        logger.info({ name }, `Removing ${name}...`);
        await removeContainer(container.Id, {}, docker);
        logRaw(`Removed ${name}`);
      }
      return;
    }

    // Stop the container
    logger.info({ name }, `Stopping ${name}...`);
    await stopContainer(container.Id, { t: 10 }, docker);
    logRaw(`Stopped ${name}`);

    // Remove container unless --keep is specified
    if (!options.keep) {
      logger.info({ name }, `Removing ${name}...`);
      await removeContainer(container.Id, {}, docker);
      logRaw(`Removed ${name}`);
    }
  } catch (error) {
    logger.error({ error, name }, `Failed to stop container ${name}`);
    throw new Error(`Failed to stop container ${name}: ${error}`);
  }
}

/**
 * Run stop command to stop heretic containers
 */
export async function runStop(name?: string, options?: StopOptions): Promise<void> {
  const logger = getLogger();
  const { all = false, force = false, keep = false, session } = options || {};

  // Check Docker availability
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    logger.error("Docker is not running or not available");
    process.exit(1);
  }

  try {
    // Build label filters
    const labelFilters = ["heretic.managed=true"];
    if (session) {
      labelFilters.push(`heretic.session=${session}`);
    }

    // List all heretic containers
    const docker = getDockerClient();
    const containers = await listContainers(docker, {
      all: true,
      filters: JSON.stringify({
        label: labelFilters,
      }),
    });

    if (containers.length === 0) {
      logRaw("No heretic containers found");
      return;
    }

    // Determine which containers to stop. Build sidecars are siblings of an
    // agent, so when stopping a single agent we also pull in its sidecars; when
    // selecting the "primary" match we look only at agent containers so a sidecar
    // is never mistaken for the agent.
    const agentContainers = containers.filter((c) => !isSidecar(c));
    let containersToStop: ContainerInfo[] = [];

    if (all) {
      // Stop all heretic containers (agents + their sidecars)
      containersToStop = containers;
    } else if (name) {
      // Find container by name or ID
      const container = await findContainerByNameOrId(name, agentContainers);
      if (!container) {
        logRaw(`No heretic container found matching '${name}'`);
        return;
      }
      containersToStop = [container, ...siblingSidecars(container, containers)];
    } else {
      // Find container for current directory
      const container = await findContainerByProject(process.cwd(), agentContainers, session);
      if (!container) {
        logRaw("No heretic container found for the current directory");
        return;
      }
      containersToStop = [container, ...siblingSidecars(container, containers)];
    }

    // Confirm before stopping unless --force is passed
    if (!force) {
      const containerNames = containersToStop
        .map((c) => c.Names[0]?.replace(/^\//, "") || c.Id.substring(0, 12))
        .join(", ");

      const answers = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Stop ${containersToStop.length} container(s): ${containerNames}? (use --force to skip)`,
          default: true,
        },
      ]);

      if (!answers.confirm) {
        logRaw("Aborted");
        return;
      }
    }

    // Stop each container
    const errors: string[] = [];
    for (const container of containersToStop) {
      try {
        await stopSingleContainer(container, { keep });
      } catch (error) {
        const name = container.Names[0]?.replace(/^\//, "") || container.Id.substring(0, 12);
        errors.push(`${name}: ${error}`);
        // Continue with other containers even if one fails
      }
    }

    // Remove the per-run build-sidecar networks once their containers are gone
    // (skip when --keep leaves containers attached). Named cache volumes are
    // intentionally preserved so caches stay warm across runs.
    if (!keep) {
      const networks = new Set<string>();
      for (const container of containersToStop) {
        const net = container.Labels?.["heretic.network"];
        if (net) networks.add(net);
      }
      for (const net of networks) {
        await removeNetworkByName(docker, net);
      }
    }

    // Report any errors at the end
    if (errors.length > 0) {
      logger.error({ errors }, "Some containers failed to stop");
      logRaw("\nErrors occurred while stopping containers:");
      errors.forEach((err) => logRaw(`  - ${err}`));
      process.exit(1);
    }
  } catch (error) {
    logger.error({ error }, "Failed to stop containers");
    process.exit(1);
  }
}
