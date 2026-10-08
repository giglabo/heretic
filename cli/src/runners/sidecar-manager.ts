/**
 * SidecarManager — dockerode-native orchestration of build sidecars.
 *
 * The compose runner (ComposeRunner.buildSidecarOrchestration) gets sidecars for
 * free from `docker compose up` (depends_on health-gating, teardown). The
 * single-container `docker` runner has none of that, so this manager reproduces
 * it with the dockerode API for parity: a per-run user-defined network, one
 * builder container per runtime sharing the agent's workspace bind, a health
 * poll that stands in for compose's `condition: service_healthy`, and label-based
 * teardown that `heretic-cli stop` can also drive when the run was detached.
 *
 * It intentionally mirrors the compose path's semantics field-for-field:
 * same BUILD_SIDECARS shape, same caller-uid default (F-2), same hardened posture
 * (cap_drop ALL + no-new-privileges + no published ports, gaps C-9), same
 * env_passthrough union (C-8), and the same `builder-<runtime>` service names —
 * here as network aliases so `http://builder-<runtime>:<port>` resolves.
 */

import type Docker from "dockerode";
import type { ContainerCreateOptions } from "dockerode";
import { createHash } from "node:crypto";
import type { BuildSidecar, ResolvedAgentConfig } from "../types/agent-profile";
import { execInContainer } from "../utils/docker";
import { sanitizeSessionName } from "../utils/session";
import { getLogger } from "../logger";

const logger = getLogger();

/** Label marking a container as a heretic-managed build sidecar. */
export const SIDECAR_ROLE_LABEL = "heretic.role";
export const SIDECAR_ROLE_VALUE = "build-sidecar";
export const SIDECAR_NETWORK_ROLE_VALUE = "build-network";

export interface SidecarWiring {
  /** JSON for the agent's BUILD_SIDECARS env (normative shape). */
  buildSidecars: string;
  /** Comma-joined SIDECAR_ENV_PASSTHROUGH allowlist (may be empty). */
  envPassthrough: string;
  /** The user-defined network the agent must join to resolve builder aliases. */
  networkName: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Manages the lifecycle of a config's build-sidecar containers for the docker runner.
 */
export class SidecarManager {
  private startedContainerIds: string[] = [];
  private networkName?: string;

  constructor(
    private config: ResolvedAgentConfig,
    private docker: Docker
  ) {}

  /** True when this config declares at least one build sidecar. */
  hasSidecars(): boolean {
    return (this.config.toolBackends?.sidecars?.length ?? 0) > 0;
  }

  private get uid(): number {
    return typeof process.getuid === "function" ? process.getuid() : 1000;
  }

  private get gid(): number {
    return typeof process.getgid === "function" ? process.getgid() : 1000;
  }

  private get runAsCallerUid(): boolean {
    return this.config.toolBackends?.run_as_caller_uid !== false; // default true
  }

  private get workspaceTarget(): string {
    return this.config.toolBackends?.workspace_target || "/workspace";
  }

  private get readyTimeout(): number {
    return this.config.toolBackends?.ready_timeout ?? 60;
  }

  /** Short, stable per-project+session suffix so names don't collide across runs. */
  private projectHash(): string {
    return createHash("sha256").update(this.config.projectDir).digest("hex").substring(0, 8);
  }

  /** Per-run network name; shared by the agent and every builder. */
  buildNetworkName(): string {
    const agent = this.config.name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const session = sanitizeSessionName(this.config.sessionName);
    return `heretic-net-${agent}-${session}-${this.projectHash()}`;
  }

  /** Daemon-unique container name for a builder (the alias stays `builder-<rt>`). */
  buildContainerName(runtime: string): string {
    const session = sanitizeSessionName(this.config.sessionName);
    return `heretic-builder-${runtime}-${session}-${this.projectHash()}`;
  }

  /** The `builder-<runtime>` alias the agent resolves over the shared network. */
  private serviceAlias(runtime: string): string {
    return `builder-${runtime}`;
  }

  /** Resolve the host:container workspace bind shared by agent and builders. */
  resolveWorkspaceBind(): string {
    const target = this.workspaceTarget;
    const vol = this.config.volumes.find((v) => v.target === target);
    if (!vol) {
      throw new Error(
        `tool_backends: no volume targets '${target}'; cannot share the workspace with build sidecars`
      );
    }
    return `${vol.source}:${target}`;
  }

  /**
   * Compute the agent-side wiring (BUILD_SIDECARS + env passthrough + network),
   * without touching Docker. Pure — used by start() and by tests.
   */
  computeWiring(): SidecarWiring {
    const sidecars = this.config.toolBackends?.sidecars || [];
    const buildSidecars: Record<string, { internal_url: string }> = {};
    const passthrough = new Set<string>();
    for (const sc of sidecars) {
      const port = sc.port ?? 8080;
      buildSidecars[sc.runtime] = {
        internal_url: `http://${this.serviceAlias(sc.runtime)}:${port}`,
      };
      for (const name of sc.env_passthrough || []) {
        passthrough.add(name);
      }
    }
    return {
      buildSidecars: JSON.stringify(buildSidecars),
      envPassthrough: [...passthrough].join(","),
      networkName: this.buildNetworkName(),
    };
  }

  /** Common heretic labels for sidecar containers (drives stop/ps cleanup). */
  private sidecarLabels(runtime: string): Record<string, string> {
    return {
      "heretic.managed": "true",
      "heretic.agent": this.config.name,
      "heretic.project": this.config.projectDir,
      "heretic.session": this.config.sessionName,
      [SIDECAR_ROLE_LABEL]: SIDECAR_ROLE_VALUE,
      "heretic.runtime": runtime,
      "heretic.network": this.buildNetworkName(),
    };
  }

  /**
   * Build the dockerode create options for one builder container. Pure — mirrors
   * ComposeRunner.buildSidecarOrchestration's per-service block.
   */
  buildBuilderCreateOptions(sc: BuildSidecar): ContainerCreateOptions {
    const port = sc.port ?? 8080;
    const workspaceTarget = this.workspaceTarget;
    const workspaceBind = this.resolveWorkspaceBind();
    const networkName = this.buildNetworkName();

    // Builder env: user-provided + a writable HOME so toolchains don't try to
    // write to a home dir that doesn't exist for an arbitrary caller uid.
    const envMap: Record<string, string> = { ...(sc.env || {}) };
    if (this.runAsCallerUid && envMap.HOME === undefined) {
      envMap.HOME = `${workspaceTarget}/.heretic-home/${sc.runtime}`;
    }
    // Ensure the baked healthcheck / server read the resolved port.
    if (envMap.EXEC_SERVER_PORT === undefined) {
      envMap.EXEC_SERVER_PORT = String(port);
    }
    const env = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);

    // Volumes: shared workspace bind + any named cache volumes (auto-created by
    // Docker on first use; intentionally NOT removed on teardown so caches warm
    // across runs — gap F-3).
    const binds: string[] = [workspaceBind, ...(sc.cache_volumes || [])];

    const cmd = sc.command ?? ["exec-server", "-port", String(port), "-cwd", workspaceTarget];

    const options: ContainerCreateOptions = {
      Image: sc.image,
      Cmd: cmd,
      WorkingDir: workspaceTarget,
      Env: env,
      Labels: this.sidecarLabels(sc.runtime),
      HostConfig: {
        Binds: binds,
        NetworkMode: networkName,
        // Local private network: drop caps + block privilege escalation to blunt
        // the unauthenticated-exec risk (gaps C-9, F-2). No published ports —
        // reachable only by alias on the shared network.
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        RestartPolicy: { Name: "no" },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: { Aliases: [this.serviceAlias(sc.runtime)] },
        },
      },
    };
    if (this.runAsCallerUid) {
      options.User = `${this.uid}:${this.gid}`;
    }
    return options;
  }

  /**
   * Create the network + start every builder, then wait for each to become
   * healthy. Returns the agent-side wiring. Tears itself down on any failure.
   */
  async start(): Promise<SidecarWiring> {
    const sidecars = this.config.toolBackends?.sidecars || [];
    const wiring = this.computeWiring();

    if (this.config.extra?.network) {
      logger.warn(
        { network: this.config.extra.network },
        "Agent uses a custom network_mode; build sidecars may be unreachable unless they share that network"
      );
    }

    try {
      await this.ensureNetwork();

      for (const sc of sidecars) {
        const name = this.buildContainerName(sc.runtime);
        await this.removeExistingByName(name);
        const options = this.buildBuilderCreateOptions(sc);
        logger.debug({ name, image: sc.image }, "Creating build sidecar");
        const container = await this.docker.createContainer({ ...options, name });
        this.startedContainerIds.push(container.id);
        await container.start();
        logger.info({ name, runtime: sc.runtime }, "Build sidecar started");
        await this.waitHealthy(container, sc.port ?? 8080, name);
      }

      logger.info({ count: sidecars.length, network: wiring.networkName }, "Build sidecars ready");
      return wiring;
    } catch (error) {
      logger.error({ error }, "Failed to start build sidecars; tearing down");
      await this.stop();
      throw error;
    }
  }

  /**
   * Poll a builder until it is healthy. Prefers the container's own HEALTHCHECK
   * (works for any image, incl. bring-your-own); falls back to an exec probe of
   * `exec-server -healthcheck` when the image declares no healthcheck. Builders
   * publish no host ports, so we can't probe over HTTP from the host.
   */
  private async waitHealthy(
    container: Docker.Container,
    port: number,
    name: string
  ): Promise<void> {
    const deadline = Date.now() + this.readyTimeout * 1000;
    while (Date.now() < deadline) {
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(
          `build sidecar '${name}' exited before becoming healthy (status: ${info.State.Status})`
        );
      }
      const health = info.State.Health?.Status;
      if (health) {
        if (health === "healthy") return;
      } else {
        // No baked HEALTHCHECK — probe directly.
        const ok = await this.execHealthProbe(container.id, port);
        if (ok) return;
      }
      await sleep(2000);
    }
    throw new Error(`build sidecar '${name}' did not become healthy within ${this.readyTimeout}s`);
  }

  private async execHealthProbe(containerId: string, port: number): Promise<boolean> {
    try {
      const { exitCode } = await execInContainer(
        containerId,
        ["exec-server", "-healthcheck", "-port", String(port)],
        this.docker
      );
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Create the per-run network, reusing it if a prior run left it behind. */
  private async ensureNetwork(): Promise<void> {
    const name = this.buildNetworkName();
    this.networkName = name;
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: {
          "heretic.managed": "true",
          "heretic.agent": this.config.name,
          "heretic.project": this.config.projectDir,
          "heretic.session": this.config.sessionName,
          [SIDECAR_ROLE_LABEL]: SIDECAR_NETWORK_ROLE_VALUE,
        },
      });
      logger.debug({ network: name }, "Created sidecar network");
    } catch (error) {
      // 409 = already exists (e.g. a prior crashed run); reuse it.
      if ((error as { statusCode?: number }).statusCode === 409) {
        logger.debug({ network: name }, "Reusing existing sidecar network");
        return;
      }
      throw error;
    }
  }

  private async removeExistingByName(name: string): Promise<void> {
    try {
      const existing = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({ name: [name] }),
      });
      for (const c of existing) {
        const container = this.docker.getContainer(c.Id);
        await container.remove({ force: true }).catch(() => undefined);
        logger.debug({ name }, "Removed stale build sidecar");
      }
    } catch (error) {
      logger.debug({ error, name }, "Failed to check/remove existing sidecar (continuing)");
    }
  }

  /**
   * Stop and remove the builders this manager started, then remove the network.
   * Named cache volumes are intentionally preserved (warm caches across runs).
   */
  async stop(): Promise<void> {
    for (const id of this.startedContainerIds) {
      try {
        const container = this.docker.getContainer(id);
        await container.remove({ force: true });
        logger.debug({ id }, "Removed build sidecar");
      } catch (error) {
        logger.debug({ error, id }, "Failed to remove build sidecar (continuing)");
      }
    }
    this.startedContainerIds = [];
    if (this.networkName) {
      await removeNetworkByName(this.docker, this.networkName);
      this.networkName = undefined;
    }
  }

  /**
   * Label-driven teardown for the detached / separate-process case (used by
   * `heretic-cli stop`): remove every build-sidecar container and network for a
   * project (optionally scoped to a session).
   */
  static async teardown(
    docker: Docker,
    filter: { project: string; session?: string }
  ): Promise<{ containers: number; networks: number }> {
    const labelFilter = [
      "heretic.managed=true",
      `${SIDECAR_ROLE_LABEL}=${SIDECAR_ROLE_VALUE}`,
      `heretic.project=${filter.project}`,
    ];
    if (filter.session) labelFilter.push(`heretic.session=${filter.session}`);

    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: labelFilter }),
    });
    let removedContainers = 0;
    for (const c of containers) {
      try {
        await docker.getContainer(c.Id).remove({ force: true });
        removedContainers++;
      } catch (error) {
        logger.debug({ error, id: c.Id }, "Failed to remove sidecar container");
      }
    }

    const netFilter = [
      "heretic.managed=true",
      `${SIDECAR_ROLE_LABEL}=${SIDECAR_NETWORK_ROLE_VALUE}`,
      `heretic.project=${filter.project}`,
    ];
    if (filter.session) netFilter.push(`heretic.session=${filter.session}`);
    const networks = await docker.listNetworks({
      filters: JSON.stringify({ label: netFilter }),
    });
    let removedNetworks = 0;
    for (const n of networks) {
      if (await removeNetworkByName(docker, n.Name)) removedNetworks++;
    }

    return { containers: removedContainers, networks: removedNetworks };
  }
}

/** Remove a network by name, tolerating "in use" / "not found". */
export async function removeNetworkByName(docker: Docker, name: string): Promise<boolean> {
  try {
    await docker.getNetwork(name).remove();
    logger.debug({ network: name }, "Removed sidecar network");
    return true;
  } catch (error) {
    logger.debug({ error, network: name }, "Could not remove network (in use or gone)");
    return false;
  }
}
