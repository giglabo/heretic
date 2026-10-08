import { spawn } from "node:child_process";
import { getLogger, logRaw } from "../logger";
import { isDockerAvailable, listContainers, getDockerClient } from "../utils/docker";
import type { ContainerInfo } from "dockerode";

/**
 * Find the container to attach to, most specific match first:
 * 1. exact container name;
 * 2. an agent profile name: that profile's session container in the current
 *    folder (with -s, that session; without, the only one or 'default');
 * 3. a container ID prefix (after profiles, so a profile named like hex
 *    digits can't hit some other container's ID).
 * No substring matching: `attach claude` must never pick `claude-zai`, nor a
 * `claude` session of another folder.
 */
export function findContainerByNameOrId(
  nameOrId: string,
  containers: ContainerInfo[],
  projectDir: string,
  session?: string
): ContainerInfo | undefined {
  const cleanNames = (c: ContainerInfo): string[] => c.Names.map((n) => n.replace(/^\//, ""));

  const exact = containers.find((c) => cleanNames(c).includes(nameOrId));
  if (exact) return exact;

  const sessions = containers.filter(
    (c) =>
      c.Labels?.["heretic.agent"] === nameOrId &&
      c.Labels?.["heretic.project"] === projectDir &&
      c.Labels?.["heretic.role"] !== "build-sidecar"
  );
  if (sessions.length === 1) return sessions[0];
  if (sessions.length > 1) {
    const wanted = session ?? "default";
    const match = sessions.find((c) => c.Labels?.["heretic.session"] === wanted);
    if (match) return match;
    const names = sessions.map((c) => c.Labels?.["heretic.session"]).join(", ");
    getLogger().error(
      `'${nameOrId}' has several sessions in this folder (${names}); pick one with -s`
    );
    return undefined;
  }

  return containers.find((c) => c.Id.startsWith(nameOrId));
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
    const containerInfo = findContainerByNameOrId(
      name,
      containers,
      process.cwd(),
      options?.session
    );
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
