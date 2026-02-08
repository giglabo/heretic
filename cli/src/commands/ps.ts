import { getLogger, logRaw } from "../logger";
import { isDockerAvailable, listContainers, getDockerClient } from "../utils/docker";
import type { Port } from "dockerode";

interface PsOptions {
  json?: boolean;
  session?: string;
}

interface ContainerData {
  name: string;
  agent: string;
  session: string;
  status: string;
  uptime: string;
  ports: string;
}

/**
 * Format relative time from timestamp
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp * 1000; // Docker timestamp is in seconds
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return `${diffHr}h ago`;
  }

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Format port mappings
 */
function formatPorts(ports: Port[]): string {
  if (!ports || ports.length === 0) {
    return "-";
  }

  const mappings = ports
    .filter((p) => p.PublicPort && p.PrivatePort)
    .map((p) => `${p.PublicPort}→${p.PrivatePort}`)
    .join(", ");

  return mappings || "-";
}

/**
 * Format table with aligned columns
 */
function formatTable(data: ContainerData[]): string {
  if (data.length === 0) {
    return "";
  }

  // Calculate column widths
  const nameWidth = Math.max(4, ...data.map((d) => d.name.length));
  const agentWidth = Math.max(5, ...data.map((d) => d.agent.length));
  const sessionWidth = Math.max(7, ...data.map((d) => d.session.length));
  const statusWidth = Math.max(6, ...data.map((d) => d.status.length));
  const uptimeWidth = Math.max(6, ...data.map((d) => d.uptime.length));
  const portsWidth = Math.max(5, ...data.map((d) => d.ports.length));

  // Build header
  const header = [
    "NAME".padEnd(nameWidth),
    "AGENT".padEnd(agentWidth),
    "SESSION".padEnd(sessionWidth),
    "STATUS".padEnd(statusWidth),
    "UPTIME".padEnd(uptimeWidth),
    "PORTS".padEnd(portsWidth),
  ].join("  ");

  // Build rows
  const rows = data.map((d) =>
    [
      d.name.padEnd(nameWidth),
      d.agent.padEnd(agentWidth),
      d.session.padEnd(sessionWidth),
      d.status.padEnd(statusWidth),
      d.uptime.padEnd(uptimeWidth),
      d.ports.padEnd(portsWidth),
    ].join("  ")
  );

  return [header, ...rows].join("\n");
}

/**
 * Run ps command to list heretic containers
 */
export async function runPs(options: PsOptions): Promise<void> {
  const logger = getLogger();

  // Check Docker availability
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    logger.error("Docker is not running or not available");
    process.exit(1);
  }

  try {
    // Build label filters
    const labelFilters = ["heretic.managed=true"];
    if (options.session) {
      labelFilters.push(`heretic.session=${options.session}`);
    }

    // List all containers with heretic label filter
    const docker = getDockerClient();
    const containers = await listContainers(docker, {
      all: true,
      filters: JSON.stringify({
        label: labelFilters,
      }),
    });

    if (containers.length === 0) {
      if (options.json) {
        logRaw(JSON.stringify([], null, 2));
      } else {
        logRaw("No running heretic agents.");
      }
      return;
    }

    // Extract and format container data
    const data: ContainerData[] = containers.map((container) => {
      // Strip leading '/' from container name
      const name = container.Names[0]?.replace(/^\//, "") || container.Id.substring(0, 12);

      // Get agent profile from labels
      const agent = container.Labels?.["heretic.agent"] || "unknown";

      // Get session from labels
      const session = container.Labels?.["heretic.session"] || "-";

      // Get status (e.g., "running", "exited")
      const status = container.State;

      // Calculate uptime
      const uptime = formatRelativeTime(container.Created);

      // Format ports
      const ports = formatPorts(container.Ports);

      return { name, agent, session, status, uptime, ports };
    });

    // Output
    if (options.json) {
      logRaw(JSON.stringify(data, null, 2));
    } else {
      const table = formatTable(data);
      logRaw(table);
    }
  } catch (error) {
    logger.error({ error }, "Failed to list containers");
    process.exit(1);
  }
}
