/**
 * Port publishing
 *
 * Parses Docker-style port specs (single ports, ranges, remaps, bind IPs,
 * protocols), expands named presets of typical development ports, and turns
 * the result into dockerode `PortBindings` / compose `ports:` entries.
 *
 * Spec grammar (same as `docker run -p`):
 *
 *   [HOST_IP:][HOST_PORT[-HOST_END]:]CONTAINER_PORT[-CONTAINER_END][/tcp|udp|sctp]
 *
 *   "3000"                     → host 3000 → container 3000
 *   "3000-3020"                → 3000..3020 on both sides
 *   "13000-13020:3000-3020"    → remapped range
 *   "15432:5432"               → remapped single port
 *   "127.0.0.1:8080:8080"      → bound to one host interface
 *   "[::1]:8080:8080"          → IPv6 host interface
 *   "127.0.0.1::8080"          → random host port on 127.0.0.1
 *   "5353/udp"                 → UDP
 */

import { createServer } from "node:net";
import { createSocket } from "node:dgram";

export type PortProtocol = "tcp" | "udp" | "sctp";

/** One parsed spec; ranges are inclusive and equally long on both sides. */
export interface PortRange {
  hostIp?: string;
  /** undefined → same as the container port; null → random host port */
  hostStart?: number | null;
  hostEnd?: number | null;
  containerStart: number;
  containerEnd: number;
  protocol: PortProtocol;
}

/** A single published port after expansion. */
export interface PortMapping {
  hostIp?: string;
  /** null → Docker picks a free host port */
  hostPort: number | null;
  containerPort: number;
  protocol: PortProtocol;
  /**
   * Came from a preset (or a spec without an explicit host port inside a
   * preset). Optional ports whose host port is busy are skipped at start
   * instead of failing the whole container.
   */
  optional: boolean;
}

/**
 * Presets of typical development ports. Values are regular port specs, so a
 * preset can mix ranges and single ports.
 */
export const PORT_PRESETS: Readonly<Record<string, readonly string[]>> = {
  web: [
    "1313", // Hugo
    "1420-1421", // Tauri
    "3000-3020", // Node, Next.js, Remix, Rails, Grafana
    "3333", // AdonisJS
    "4000-4010", // Phoenix, Jekyll, GraphQL servers
    "4173-4180", // Vite preview
    "4200-4210", // Angular
    "4321-4330", // Astro
    "4983", // Drizzle Studio
    "5000-5010", // Flask, .NET, serve
    "5173-5190", // Vite
    "5555", // Prisma Studio
    "6006-6010", // Storybook
    "8000-8020", // Django, uvicorn, php -S, http.server
    "8080-8100", // APIs, Java, webpack, Metro (8081)
    "8443", // HTTPS dev servers
    "8888-8890", // Jupyter
    "9000-9010", // PHP-FPM, MinIO, SonarQube
    "19000-19006", // Expo
    "24678", // Vite HMR websocket
    "35729", // LiveReload
  ],
  debug: [
    "2345", // Delve (Go)
    "5005", // JDWP (Java)
    "5678", // debugpy (Python)
    "9222", // Chrome DevTools
    "9229-9239", // Node.js inspector
  ],
  db: [
    "3306", // MySQL / MariaDB
    "5432-5433", // PostgreSQL
    "5672", // RabbitMQ
    "6379", // Redis
    "7700", // Meilisearch
    "8123", // ClickHouse HTTP
    "9200", // Elasticsearch / OpenSearch
    "15672", // RabbitMQ UI
    "27017", // MongoDB
  ],
  supabase: [
    "54320-54330", // Supabase CLI (API, DB, Studio, mail, pooler, analytics)
  ],
  mail: [
    "1025", // Mailpit / MailHog SMTP
    "8025", // Mailpit / MailHog UI
  ],
};

/** Composite presets: expanded into their members. */
export const PORT_PRESET_GROUPS: Readonly<Record<string, readonly string[]>> = {
  dev: ["web", "debug"],
  all: ["web", "debug", "db", "supabase", "mail"],
};

/** Every preset name, groups included. */
export function listPortPresets(): string[] {
  return [...Object.keys(PORT_PRESET_GROUPS), ...Object.keys(PORT_PRESETS)];
}

/**
 * Expand preset names (comma-separated values allowed) into port specs.
 * Throws on an unknown name.
 */
export function presetPortSpecs(names: readonly string[]): string[] {
  const specs: string[] = [];
  const seen = new Set<string>();

  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const group = PORT_PRESET_GROUPS[name];
    if (group) {
      group.forEach(add);
      return;
    }
    const preset = PORT_PRESETS[name];
    if (!preset) {
      throw new Error(`Unknown port preset '${name}' (available: ${listPortPresets().join(", ")})`);
    }
    specs.push(...preset);
  };

  for (const raw of names) {
    for (const name of raw.split(",")) {
      const trimmed = name.trim();
      if (trimmed) add(trimmed);
    }
  }
  return specs;
}

function parsePort(value: string, spec: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid port '${value}' in '${spec}'`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`Port ${port} out of range 1-65535 in '${spec}'`);
  }
  return port;
}

function parseRange(value: string, spec: string): [number, number] {
  const dash = value.indexOf("-");
  if (dash === -1) {
    const port = parsePort(value, spec);
    return [port, port];
  }
  const start = parsePort(value.slice(0, dash), spec);
  const end = parsePort(value.slice(dash + 1), spec);
  if (end < start) {
    throw new Error(`Port range end is below its start in '${spec}'`);
  }
  return [start, end];
}

/**
 * Parse one port spec. Throws an Error with a user-facing message on bad input.
 */
export function parsePortSpec(spec: string): PortRange {
  const input = spec.trim();
  if (!input) {
    throw new Error("Port spec must be non-empty");
  }

  let rest = input;
  let protocol: PortProtocol = "tcp";
  const slash = rest.lastIndexOf("/");
  if (slash !== -1) {
    const proto = rest.slice(slash + 1).toLowerCase();
    if (proto !== "tcp" && proto !== "udp" && proto !== "sctp") {
      throw new Error(`Invalid protocol '${proto}' in '${spec}' (tcp, udp or sctp)`);
    }
    protocol = proto;
    rest = rest.slice(0, slash);
  }

  let hostIp: string | undefined;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]:");
    if (close === -1) {
      throw new Error(`Invalid IPv6 host address in '${spec}' (expected [addr]:port:port)`);
    }
    hostIp = rest.slice(1, close);
    rest = rest.slice(close + 2);
  }

  const parts = rest.split(":");
  let hostPart: string | undefined;
  let containerPart: string;
  if (hostIp !== undefined) {
    if (parts.length !== 2) {
      throw new Error(`Invalid port spec '${spec}'`);
    }
    [hostPart, containerPart] = parts;
  } else if (parts.length === 1) {
    containerPart = parts[0];
  } else if (parts.length === 2) {
    [hostPart, containerPart] = parts;
  } else if (parts.length === 3) {
    [hostIp, hostPart, containerPart] = parts;
    if (!hostIp) {
      throw new Error(`Empty host address in '${spec}'`);
    }
  } else {
    throw new Error(`Invalid port spec '${spec}' (IPv6 addresses need brackets: [::1]:80:80)`);
  }

  const [containerStart, containerEnd] = parseRange(containerPart, spec);

  let hostStart: number | null | undefined;
  let hostEnd: number | null | undefined;
  if (hostPart === "") {
    // "ip::port" → random host port (single ports only)
    if (containerStart !== containerEnd) {
      throw new Error(`A random host port needs a single container port in '${spec}'`);
    }
    hostStart = null;
    hostEnd = null;
  } else if (hostPart !== undefined) {
    [hostStart, hostEnd] = parseRange(hostPart, spec);
    if (hostEnd - hostStart !== containerEnd - containerStart) {
      throw new Error(`Host and container ranges have different lengths in '${spec}'`);
    }
  }

  return { hostIp, hostStart, hostEnd, containerStart, containerEnd, protocol };
}

export interface BuildPortMappingsOptions {
  /** Explicit specs (profile `extra.ports`, `--port`) */
  ports?: readonly string[];
  /** Preset names (profile `extra.port_presets`, `--port-preset`) */
  presets?: readonly string[];
  /** Bind IP for specs that don't name one (profile `extra.ports_host_ip`) */
  hostIp?: string;
  /**
   * Shift the host side of every spec without an explicit host port, presets
   * included (profile `extra.ports_offset`). E.g. 10000: 3000 → 13000:3000.
   */
  offset?: number;
}

function key(protocol: PortProtocol, containerPort: number): string {
  return `${containerPort}/${protocol}`;
}

function expand(
  spec: string,
  optional: boolean,
  hostIp: string | undefined,
  offset: number
): PortMapping[] {
  const range = parsePortSpec(spec);
  const mappings: PortMapping[] = [];
  for (let i = 0; i <= range.containerEnd - range.containerStart; i++) {
    const containerPort = range.containerStart + i;
    let hostPort: number | null;
    if (range.hostStart === null) {
      hostPort = null;
    } else if (range.hostStart === undefined) {
      hostPort = containerPort + offset;
      if (hostPort < 1 || hostPort > 65535) {
        throw new Error(`Port offset ${offset} moves '${spec}' out of range 1-65535`);
      }
    } else {
      hostPort = range.hostStart + i;
    }
    mappings.push({
      hostIp: range.hostIp ?? hostIp,
      hostPort,
      containerPort,
      protocol: range.protocol,
      optional,
    });
  }
  return mappings;
}

/**
 * Resolve presets and explicit specs into a de-duplicated list of mappings,
 * sorted by protocol and container port. One host binding per container port:
 * explicit specs win over presets, later specs over earlier ones — so
 * "15432:5432" remaps the 5432 that a preset brought in.
 */
export function buildPortMappings(options: BuildPortMappingsOptions): PortMapping[] {
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset)) {
    throw new Error(`Port offset must be an integer, got ${offset}`);
  }
  const hostIp = options.hostIp?.trim() || undefined;
  const byKey = new Map<string, PortMapping>();

  for (const spec of presetPortSpecs(options.presets ?? [])) {
    for (const m of expand(spec, true, hostIp, offset)) {
      byKey.set(key(m.protocol, m.containerPort), m);
    }
  }
  for (const spec of options.ports ?? []) {
    for (const m of expand(spec, false, hostIp, offset)) {
      byKey.set(key(m.protocol, m.containerPort), m);
    }
  }

  const order: Record<PortProtocol, number> = { tcp: 0, udp: 1, sctp: 2 };
  return [...byKey.values()].sort(
    (a, b) => order[a.protocol] - order[b.protocol] || a.containerPort - b.containerPort
  );
}

function formatHost(ip: string | undefined): string {
  if (!ip) return "";
  return ip.includes(":") ? `[${ip}]:` : `${ip}:`;
}

/**
 * Format mappings back into compact specs, joining consecutive ports into
 * ranges. The output is valid for both `docker run -p` and compose `ports:`.
 */
export function formatPortMappings(mappings: readonly PortMapping[]): string[] {
  const specs: string[] = [];
  let i = 0;
  while (i < mappings.length) {
    const first = mappings[i];
    let j = i;
    while (
      j + 1 < mappings.length &&
      first.hostPort !== null &&
      mappings[j + 1].protocol === first.protocol &&
      mappings[j + 1].hostIp === first.hostIp &&
      mappings[j + 1].containerPort === mappings[j].containerPort + 1 &&
      mappings[j + 1].hostPort === (mappings[j].hostPort as number) + 1
    ) {
      j++;
    }
    const last = mappings[j];
    const container =
      first.containerPort === last.containerPort
        ? `${first.containerPort}`
        : `${first.containerPort}-${last.containerPort}`;
    const host =
      first.hostPort === null
        ? ""
        : first.hostPort === last.hostPort
          ? `${first.hostPort}`
          : `${first.hostPort}-${last.hostPort}`;
    const proto = first.protocol === "tcp" ? "" : `/${first.protocol}`;
    specs.push(`${formatHost(first.hostIp)}${host}:${container}${proto}`);
    i = j + 1;
  }
  return specs;
}

/** dockerode shapes for `ExposedPorts` and `HostConfig.PortBindings`. */
export interface DockerPortConfig {
  exposedPorts: Record<string, Record<string, never>>;
  portBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>>;
}

/**
 * Translate specs into dockerode options. Ports must be listed in
 * `ExposedPorts` too: the Engine API ignores bindings for ports the image
 * does not EXPOSE (the docker CLI adds them implicitly).
 */
export function toDockerPortConfig(specs: readonly string[]): DockerPortConfig {
  const exposedPorts: DockerPortConfig["exposedPorts"] = {};
  const portBindings: DockerPortConfig["portBindings"] = {};
  for (const spec of specs) {
    for (const m of expand(spec, false, undefined, 0)) {
      const k = key(m.protocol, m.containerPort);
      exposedPorts[k] = {};
      const binding = {
        ...(m.hostIp ? { HostIp: m.hostIp } : {}),
        HostPort: m.hostPort === null ? "" : String(m.hostPort),
      };
      (portBindings[k] ??= []).push(binding);
    }
  }
  return { exposedPorts, portBindings };
}

/** Check whether a host port can be bound right now. */
export function isHostPortFree(
  port: number,
  protocol: PortProtocol,
  hostIp?: string
): Promise<boolean> {
  // An empty bind IP means Docker's default (all interfaces).
  const ip = hostIp || "0.0.0.0";
  if (protocol === "udp") {
    return new Promise((resolve) => {
      const socket = createSocket(ip.includes(":") ? "udp6" : "udp4");
      socket.once("error", () => {
        socket.close();
        resolve(false);
      });
      socket.bind(port, ip, () => socket.close(() => resolve(true)));
    });
  }
  if (protocol === "sctp") {
    // Node has no SCTP sockets; let Docker report conflicts.
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: ip, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Drop optional (preset) mappings whose host port is already taken — by a
 * local dev server, a database, or another agent container with the same
 * preset — so one busy port doesn't stop the whole container. Explicit
 * mappings are always kept; Docker reports their conflicts.
 */
export async function dropBusyOptionalPorts(
  mappings: readonly PortMapping[],
  isFree: (
    port: number,
    protocol: PortProtocol,
    hostIp?: string
  ) => Promise<boolean> = isHostPortFree
): Promise<{ kept: PortMapping[]; dropped: PortMapping[] }> {
  const checks = await Promise.all(
    mappings.map((m) =>
      m.optional && m.hostPort !== null
        ? isFree(m.hostPort, m.protocol, m.hostIp)
        : Promise.resolve(true)
    )
  );
  const kept: PortMapping[] = [];
  const dropped: PortMapping[] = [];
  mappings.forEach((m, i) => (checks[i] ? kept : dropped).push(m));
  return { kept, dropped };
}
