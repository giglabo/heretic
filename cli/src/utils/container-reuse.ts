/**
 * Reusing a session's agent container instead of recreating it on every `run`.
 *
 * A session container is identified by its name (`getAgentContainerName()`) AND
 * its labels: the name alone can collide (sanitized session names, 8-char
 * project hash), the labels carry the exact profile, folder and session.
 * Whether a stopped container is still current is decided by a hash of the
 * create options it was made from, stored in the `heretic.config-hash` label.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type Docker from "dockerode";
import type { ContainerCreateOptions } from "dockerode";
import { getDockerClient } from "./docker";

/** Label holding the hash of the create options the container was made from. */
export const CONFIG_HASH_LABEL = "heretic.config-hash";

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

/**
 * Hash of the container create options: image, command, env (secrets
 * included — only the hash is stored), mounts, ports, user, resources, labels.
 * Env and bind order don't matter. The config-hash label itself is excluded.
 *
 * @param options - Create options as passed to `docker.createContainer`
 * @returns Hex SHA-256
 */
export function computeConfigHash(options: ContainerCreateOptions): string {
  const labels = { ...(options.Labels || {}) };
  delete labels[CONFIG_HASH_LABEL];
  const normalized = {
    ...options,
    Labels: labels,
    Env: options.Env ? [...options.Env].sort() : undefined,
    HostConfig: options.HostConfig
      ? {
          ...options.HostConfig,
          Binds: options.HostConfig.Binds ? [...options.HostConfig.Binds].sort() : undefined,
        }
      : undefined,
  };
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
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
