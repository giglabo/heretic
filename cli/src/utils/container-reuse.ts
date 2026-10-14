/**
 * Reusing a session's agent container instead of recreating it on every `run`.
 *
 * A session container is identified by its name (`getAgentContainerName()`) AND
 * its labels: the name alone can collide (sanitized session names, 8-char
 * project hash), the labels carry the exact profile, folder and session.
 * Whether a stopped container is still current is decided by a hash of the
 * create options it was made from, stored in the `heretic.config-hash` label.
 *
 * A container is never thrown away because of where it stands on the host:
 * its published ports are left out of the hash (which host ports are free
 * changes from run to run), and a container whose ports are taken, or whose
 * configuration changed, is carried over — committed to a snapshot image and
 * created again from it — so the files inside it survive (`decideReuse`).
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type Docker from "dockerode";
import type { ContainerCreateOptions } from "dockerode";
import { getDockerClient } from "./docker";

/** Label holding the hash of the create options the container was made from. */
export const CONFIG_HASH_LABEL = "heretic.config-hash";

/**
 * Label holding the image ID the container's files descend from. A container
 * carried over runs from a snapshot image, so its own ImageID is the
 * snapshot's; this label still names the profile image it started from.
 */
export const BASE_IMAGE_LABEL = "heretic.base-image";

/** Repository of the snapshot images a carried-over container runs from. */
export const SNAPSHOT_REPO = "heretic-snapshot";

/** Profile + folder + session that a session container belongs to. */
export interface SessionIdentity {
  name: string;
  projectDir: string;
  sessionName: string;
}

/** JSON with object keys sorted, so equal options always hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashOptions(options: ContainerCreateOptions, withPorts: boolean): string {
  const labels = { ...(options.Labels || {}) };
  delete labels[CONFIG_HASH_LABEL];
  delete labels[BASE_IMAGE_LABEL];
  const normalized = {
    ...options,
    Labels: labels,
    Env: options.Env ? [...options.Env].sort() : undefined,
    ExposedPorts: withPorts ? options.ExposedPorts : undefined,
    HostConfig: options.HostConfig
      ? {
          ...options.HostConfig,
          Binds: options.HostConfig.Binds ? [...options.HostConfig.Binds].sort() : undefined,
          PortBindings: withPorts ? options.HostConfig.PortBindings : undefined,
        }
      : undefined,
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

/**
 * Hash of the container create options: image, command, env (secrets
 * included — only the hash is stored), mounts, user, resources, labels.
 * Env and bind order don't matter. The config-hash and base-image labels are
 * excluded, and so are the published ports: which host ports are free changes
 * from run to run, and a busy one must never make a container look changed.
 *
 * @param options - Create options as passed to `docker.createContainer`
 * @returns Hex SHA-256
 */
export function computeConfigHash(options: ContainerCreateOptions): string {
  return hashOptions(options, false);
}

/** `null` and `{}` read back from `docker inspect` mean "no ports", as `undefined` did at create. */
function emptyToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return undefined;
  return value;
}

/**
 * The hashes a container made before ports were left out may carry: these
 * options with the ports that container was created with put back — as
 * `docker inspect` reads them, and with the `HostIp` Docker fills in
 * ("0.0.0.0") dropped, as heretic passes a binding with no bind IP.
 */
export function legacyConfigHashes(
  options: ContainerCreateOptions,
  exposedPorts: unknown,
  portBindings: unknown
): string[] {
  const exposed = emptyToUndefined(exposedPorts) as ContainerCreateOptions["ExposedPorts"];
  const raw = emptyToUndefined(portBindings) as
    | Record<string, Array<Record<string, string>>>
    | undefined;
  const withoutDefaultIp = raw
    ? Object.fromEntries(
        Object.entries(raw).map(([key, bindings]) => [
          key,
          (bindings || []).map((b) => {
            const { HostIp, ...rest } = b || {};
            return HostIp && HostIp !== "0.0.0.0" ? b : rest;
          }),
        ])
      )
    : undefined;
  const hashWith = (bindings: unknown): string =>
    hashOptions(
      {
        ...options,
        ExposedPorts: exposed,
        HostConfig: {
          ...(options.HostConfig || {}),
          PortBindings: bindings as NonNullable<
            ContainerCreateOptions["HostConfig"]
          >["PortBindings"],
        },
      },
      true
    );
  return [...new Set([hashWith(raw), hashWith(withoutDefaultIp)])];
}

/** One host port a container publishes. */
export interface HostPort {
  port: number;
  protocol: "tcp" | "udp" | "sctp";
  hostIp?: string;
}

/** The host ports in a container's `HostConfig.PortBindings`. */
export function hostPortsOf(portBindings: unknown): HostPort[] {
  if (!portBindings || typeof portBindings !== "object") return [];
  const ports: HostPort[] = [];
  for (const [key, bindings] of Object.entries(portBindings as Record<string, unknown>)) {
    const protocol = (key.split("/")[1] || "tcp") as HostPort["protocol"];
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings as Array<{ HostIp?: string; HostPort?: string }>) {
      const port = Number(binding?.HostPort);
      if (Number.isInteger(port) && port > 0) {
        ports.push({ port, protocol, hostIp: binding.HostIp || undefined });
      }
    }
  }
  return ports;
}

/** What to do with a stopped container that has this session's name. */
export type ReuseDecision =
  | { kind: "reuse" }
  | { kind: "carry"; reason: string }
  | { kind: "snapshot-and-replace"; reason: string }
  | { kind: "refuse"; reason: string };

/**
 * Decide what `run` does with a stopped container of this session's name.
 *
 * - another profile's, folder's or session's container is never touched;
 * - a container whose profile image was rebuilt is snapshotted (its files kept
 *   in a `heretic-snapshot` image) and replaced by a fresh one;
 * - an unchanged container whose host ports are free is started as it is;
 * - anything else (ports taken on the host, configuration changed, a
 *   container from before reuse) is carried over: same files, current
 *   configuration, only the host ports that are free.
 */
export function decideReuse(input: {
  owned: boolean;
  /** The image the container's files descend from (label, else its ImageID). */
  baseImage?: string;
  /** The profile image's ID now, when known. */
  imageId?: string;
  storedHash?: string;
  hash: string;
  /** The hashes with the container's own ports put back, for old containers. */
  legacyHashes?: string[];
  /** Host ports the container publishes that are taken now, as text. */
  busyPorts: string[];
}): ReuseDecision {
  if (!input.owned) {
    return {
      kind: "refuse",
      reason: "it belongs to another profile, folder or session",
    };
  }
  if (input.imageId && input.baseImage && input.baseImage !== input.imageId) {
    return { kind: "snapshot-and-replace", reason: "the profile image was rebuilt" };
  }
  const unchanged =
    input.storedHash !== undefined &&
    (input.storedHash === input.hash || (input.legacyHashes ?? []).includes(input.storedHash));
  if (unchanged && input.busyPorts.length === 0) return { kind: "reuse" };
  if (unchanged) {
    return {
      kind: "carry",
      reason: `host port(s) ${summarizePorts(input.busyPorts)} are taken by something else`,
    };
  }
  if (input.storedHash === undefined) {
    return { kind: "carry", reason: "it was made before container reuse" };
  }
  return {
    kind: "carry",
    reason: "the configuration changed (profile, local override or flags)",
  };
}

/** "1313, 1420, 3000 and 247 more" — a long port list kept readable. */
export function summarizePorts(ports: string[], shown = 8): string {
  if (ports.length <= shown) return ports.join(", ");
  return `${ports.slice(0, shown).join(", ")} and ${ports.length - shown} more`;
}

/** Whether a Docker error says a host port is taken. */
export function isPortConflict(error: unknown): boolean {
  return /port is already allocated|address already in use|ports are not available/i.test(
    describeError(error)
  );
}

/** The message of a dockerode (or any) error, never an empty `{}`. */
export function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { json?: { message?: string }; reason?: string; message?: string };
    const text = e.json?.message || e.message || e.reason;
    if (text)
      return String(text)
        .replace(/^\(HTTP code \d+\) [^-]*- /, "")
        .trim();
  }
  return String(error);
}

/**
 * Whether a container's labels say it is this profile's session container in
 * this folder (and not another folder's or session's that got the same name).
 */
export function ownsSessionContainer(
  labels: Record<string, string> | undefined,
  identity: SessionIdentity
): boolean {
  return (
    labels?.["heretic.managed"] === "true" &&
    labels["heretic.agent"] === identity.name &&
    labels["heretic.project"] === identity.projectDir &&
    labels["heretic.session"] === identity.sessionName &&
    labels["heretic.role"] !== "build-sidecar"
  );
}

/**
 * `docker attach` to a running container with the terminal inherited.
 *
 * @returns The container's exit code once it has stopped, or undefined when
 *          the user detached (Ctrl+P, Ctrl+Q) and it is still running.
 */
export async function attachToContainer(
  containerId: string,
  docker?: Docker
): Promise<number | undefined> {
  const client = docker || getDockerClient();
  const code = await new Promise<number>((resolve, reject) => {
    const proc = spawn("docker", ["attach", containerId], { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (c) => resolve(c ?? 0));
  });
  try {
    const info = await client.getContainer(containerId).inspect();
    return info.State.Running ? undefined : info.State.ExitCode;
  } catch {
    return code;
  }
}
