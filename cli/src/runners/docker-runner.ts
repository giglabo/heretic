/**
 * Docker Runner Implementation
 *
 * Implements the Runner interface using dockerode to manage single-container
 * agent execution. Supports interactive TTY mode, detached mode, and
 * container lifecycle management.
 */

import type Docker from "dockerode";
import type { ContainerCreateOptions, ContainerInfo } from "dockerode";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ResolvedAgentConfig } from "../types/agent-profile";
import type { Runner, RunResult } from "./types";
import {
  getDockerClient,
  getDindWiring,
  isDockerAvailable,
  pullImage,
  stopContainer,
  removeContainer,
  findContainerByName,
  isContainerActive,
} from "../utils/docker";
import {
  BASE_IMAGE_LABEL,
  CONFIG_HASH_LABEL,
  SNAPSHOT_REPO,
  computeConfigHash,
  decideReuse,
  describeError,
  hostPortsOf,
  isPortConflict,
  legacyConfigHashes,
  ownsSessionContainer,
  type ReuseDecision,
} from "../utils/container-reuse";
import {
  writeMcpFile,
  cleanupMcpFile,
  getMcpMountPaths,
  getExistingMcpPath,
  hasUsableMcpConfig,
} from "./mcp-helper";
import { SidecarManager, type SidecarWiring } from "./sidecar-manager";
import { appendBinds, prepareSshBackend } from "./ssh-backend";
import { ensureNestedMountpoints } from "./mountpoints";
import { loadSettings, resolveToken } from "../utils/settings";
import { ensureSessionDir, getAgentContainerName } from "../utils/session";
import { generateEntrypoint } from "../templates";
import { getLogger } from "../logger";
import { isHostPortFree, toDockerPortConfig } from "../utils/ports";

const logger = getLogger();

/** A stopped container being carried over to a new one with the same files. */
interface Carried {
  oldId: string;
  oldImage: string;
  /** The name the old container was moved to while the new one takes its own. */
  aside: string;
  /** The snapshot image the new container is created from. */
  snapshot: string;
}

/** "20261014-193306" — a UTC stamp for snapshot tags and names set aside. */
function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/**
 * Docker runner that manages a single container for an agent
 */
export class DockerRunner implements Runner {
  private docker: Docker;
  private containerId?: string;
  private mcpFilePath?: string;
  private sidecarManager?: SidecarManager;
  private sidecarsStarted = false;
  /** The container was created by this run, so a failed run may remove it. */
  private createdThisRun = false;

  constructor(private config: ResolvedAgentConfig) {
    this.docker = getDockerClient();
  }

  async start(options?: {
    detach?: boolean;
    command?: string[];
    recreate?: boolean;
  }): Promise<RunResult> {
    const { detach = false, command, recreate = false } = options || {};

    try {
      // Check Docker availability
      const available = await isDockerAvailable(this.docker);
      if (!available) {
        throw new Error("Docker is not available. Please ensure Docker is running.");
      }

      // Check if image exists locally, pull if not
      const imageId = await this.ensureImage();

      // Build sidecars (dockerode-native): the agent-side wiring is computed up
      // front so the create options (and their hash) are known before anything
      // starts; the builders themselves come up right before the agent.
      if (this.config.toolBackends?.sidecars?.length) {
        this.sidecarManager = new SidecarManager(this.config, this.docker);
      }
      const plannedWiring = this.sidecarManager?.computeWiring();

      const containerOptions = this.translateConfig(command, plannedWiring);
      const configHash = computeConfigHash(containerOptions);
      containerOptions.Labels = {
        ...containerOptions.Labels,
        [CONFIG_HASH_LABEL]: configHash,
        ...(imageId ? { [BASE_IMAGE_LABEL]: imageId } : {}),
      };
      const containerName = this.generateContainerName();

      // Reuse this session's stopped container, so what was installed or
      // changed inside it survives between runs. One that can't start as it is
      // (its host ports taken, its configuration changed) is carried over to a
      // new container with the same files — never thrown away (decideReuse).
      let carried: Carried | undefined;
      if (!recreate) {
        const found = await this.planReuse(containerName, containerOptions, configHash, imageId);
        if (found?.decision.kind === "refuse") {
          throw new Error(
            `A container named '${containerName}' exists, but ${found.decision.reason}; it was left alone. ` +
              `Use another session name (-s <name>), or remove it yourself: docker rm ${containerName}`
          );
        }
        if (found?.decision.kind === "reuse") {
          const resumed = await this.resumeContainer(found.existing, containerName, detach);
          if (resumed !== "ports-taken") return resumed;
          carried = await this.carryOver(
            found.existing,
            containerName,
            "Docker says a host port it publishes is taken"
          );
        } else if (found?.decision.kind === "carry") {
          carried = await this.carryOver(found.existing, containerName, found.decision.reason);
        } else if (found?.decision.kind === "snapshot-and-replace") {
          await this.snapshotAndRemove(found.existing, containerName, found.decision.reason);
        }
      }

      // Wait for every builder to be healthy BEFORE the agent starts — the
      // parity equivalent of compose's `depends_on: { condition: service_healthy }`.
      await this.startSidecars();

      logger.debug({ containerOptions, containerName }, "Creating container");

      // --recreate: the person asked for a fresh container in place of this one
      if (recreate) await this.removeExistingContainer(containerName);

      let container: Docker.Container;
      try {
        container = await this.docker.createContainer({
          ...containerOptions,
          ...(carried ? { Image: carried.snapshot } : {}),
          name: containerName,
        });
      } catch (error) {
        if (carried) await this.undoCarry(carried, containerName);
        throw error;
      }

      this.containerId = container.id;
      if (carried) {
        // The files now live in this container (and its snapshot): a failure
        // below leaves it for the next run rather than removing it.
        await this.finishCarry(carried);
      } else {
        this.createdThisRun = true;
      }
      logger.info({ containerId: this.containerId, name: containerName }, "Container created");

      // Handle detached vs interactive mode
      if (detach) {
        // Detached mode: just start the container
        await container.start();
        logger.info({ containerId: this.containerId }, "Container started");
        await this.fixMountPermissions(container);
        return {
          containerId: this.containerId,
          status: "running",
        };
      } else {
        // Interactive mode: attach BEFORE starting so stdin is connected when shell starts
        return await this.runInteractive(container);
      }
    } catch (error) {
      // Cleanup: remove the container only if this run created it fresh; a
      // reused or carried-over one holds the session's files and is kept.
      if (this.containerId && this.createdThisRun) {
        try {
          await removeContainer(this.containerId, { force: true }, this.docker);
        } catch (cleanupError) {
          logger.debug({ error: cleanupError }, "Failed to cleanup container");
        }
      }
      this.containerId = undefined;
      this.createdThisRun = false;

      // Cleanup MCP temp file
      if (this.mcpFilePath) {
        cleanupMcpFile(this.mcpFilePath);
        this.mcpFilePath = undefined;
      }

      // Tear down any build sidecars we brought up for this (failed) run
      if (this.sidecarManager) {
        try {
          await this.sidecarManager.stop();
        } catch (sidecarError) {
          logger.debug({ error: sidecarError }, "Failed to clean up build sidecars");
        }
        this.sidecarManager = undefined;
        this.sidecarsStarted = false;
      }

      this.handleError(error);
      throw error;
    }
  }

  async stop(options?: { timeout?: number; remove?: boolean }): Promise<void> {
    const { timeout = 10, remove = true } = options || {};

    if (!this.containerId) {
      throw new Error("No container to stop");
    }

    try {
      logger.info({ containerId: this.containerId }, "Stopping container");
      await stopContainer(this.containerId, { t: timeout }, this.docker);

      if (remove) {
        logger.info({ containerId: this.containerId }, "Removing container");
        await removeContainer(this.containerId, {}, this.docker);
      }

      // Cleanup MCP temp file
      if (this.mcpFilePath) {
        cleanupMcpFile(this.mcpFilePath);
        this.mcpFilePath = undefined;
      }

      // Tear down build sidecars + their network (in-process case). The
      // detached / separate-process case is handled by `heretic-cli stop` via
      // SidecarManager.teardown() on the shared labels.
      if (this.sidecarManager) {
        await this.sidecarManager.stop();
        this.sidecarManager = undefined;
        this.sidecarsStarted = false;
      }

      this.containerId = undefined;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async attach(): Promise<void> {
    if (!this.containerId) {
      throw new Error("No container to attach to");
    }

    const container = this.docker.getContainer(this.containerId);

    try {
      // Check if container is running
      const running = await this.isRunning();
      if (!running) {
        throw new Error("Container is not running");
      }

      logger.info({ containerId: this.containerId }, "Attaching to container");

      // Attach to container streams
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
      });

      // Pipe container streams to process streams
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      stream.pipe(process.stdout);
      if (process.stdin) {
        process.stdin.pipe(stream);
      }

      // Wait for container to exit
      await container.wait();

      // Restore terminal
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch (error) {
      // Restore terminal on error
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // Ignore errors restoring terminal
        }
      }

      this.handleError(error);
      throw error;
    }
  }

  async isRunning(): Promise<boolean> {
    if (!this.containerId) {
      return false;
    }

    try {
      const container = this.docker.getContainer(this.containerId);
      const info = await container.inspect();
      return info.State.Running === true;
    } catch (error) {
      logger.debug({ error, containerId: this.containerId }, "Container not found");
      return false;
    }
  }

  getContainerId(): string | undefined {
    return this.containerId;
  }

  /**
   * Ensure the Docker image is available locally, pull if not
   */
  private async ensureImage(): Promise<string | undefined> {
    const imageName = this.config.image;

    // Normalize image name for comparison (add :latest if no tag)
    const normalizedName = imageName.includes(":") ? imageName : `${imageName}:latest`;

    try {
      // Check if image exists locally
      const images = await this.docker.listImages();
      const local = images.find((img) => {
        if (!img.RepoTags) return false;
        return img.RepoTags.some((tag) => {
          // Check exact match or match with :latest suffix
          return tag === imageName || tag === normalizedName;
        });
      });

      if (!local) {
        logger.info({ image: imageName }, "Image not found locally, pulling...");

        await pullImage(
          imageName,
          (progress) => {
            if (progress.status && progress.id) {
              logger.debug({ id: progress.id, status: progress.status }, "Pull progress");
            }
          },
          this.docker
        );

        logger.info({ image: imageName }, "Image pulled successfully");
        // The image ID tells a reusable container from one made of an older build
        return await this.docker
          .getImage(imageName)
          .inspect()
          .then((info) => info.Id)
          .catch(() => undefined);
      }
      logger.debug({ image: imageName }, "Image exists locally");
      return local.Id;
    } catch (error) {
      logger.error({ error, image: imageName }, "Failed to pull image");
      throw new Error(`Failed to pull image ${imageName}: ${error}`);
    }
  }

  /** Bring up the build sidecars once per run (no-op without sidecars). */
  private async startSidecars(): Promise<void> {
    if (this.sidecarManager && !this.sidecarsStarted) {
      await this.sidecarManager.start();
      this.sidecarsStarted = true;
    }
  }

  /**
   * This session's stopped container and what to do with it (decideReuse):
   * start it as it is, carry it over, snapshot and replace it, or leave
   * another session's container alone. Undefined when there is none, or it is
   * live (`run` attaches to a live one before getting here).
   */
  private async planReuse(
    containerName: string,
    options: ContainerCreateOptions,
    configHash: string,
    imageId: string | undefined
  ): Promise<{ existing: ContainerInfo; decision: ReuseDecision } | undefined> {
    let existing: ContainerInfo | undefined;
    try {
      existing = await findContainerByName(containerName, this.docker);
    } catch (error) {
      logger.debug({ error, containerName }, "Failed to look up existing container");
      return undefined;
    }
    if (!existing || isContainerActive(existing)) return undefined;

    // The ports it was created with: list() shows them only while it runs.
    let exposedPorts: unknown;
    let portBindings: unknown;
    try {
      const info = await this.docker.getContainer(existing.Id).inspect();
      exposedPorts = info.Config?.ExposedPorts;
      portBindings = info.HostConfig?.PortBindings;
    } catch (error) {
      logger.debug({ error, containerName }, "Could not inspect the stopped container");
    }
    const published = hostPortsOf(portBindings);
    const free = await Promise.all(
      published.map((p) => isHostPortFree(p.port, p.protocol, p.hostIp))
    );
    const busyPorts = published
      .filter((_, i) => !free[i])
      .map((p) => (p.protocol === "tcp" ? String(p.port) : `${p.port}/${p.protocol}`));

    const decision = decideReuse({
      owned: ownsSessionContainer(existing.Labels, this.config),
      baseImage: existing.Labels?.[BASE_IMAGE_LABEL] ?? existing.ImageID,
      imageId,
      storedHash: existing.Labels?.[CONFIG_HASH_LABEL],
      hash: configHash,
      legacyHashes: legacyConfigHashes(options, exposedPorts, portBindings),
      busyPorts,
    });
    return { existing, decision };
  }

  /**
   * Start a reusable stopped container again. "ports-taken" when Docker says
   * a host port it publishes is taken, so the caller carries it over; any
   * other refusal is an error that leaves the container as it is.
   */
  private async resumeContainer(
    existing: ContainerInfo,
    containerName: string,
    detach: boolean
  ): Promise<RunResult | "ports-taken"> {
    logger.info(`Reusing stopped container '${containerName}' (pass --recreate for a fresh one)`);
    await this.startSidecars();
    const container = this.docker.getContainer(existing.Id);
    try {
      await container.start();
    } catch (error) {
      if (isPortConflict(error)) {
        logger.warn(`Could not start '${containerName}': ${describeError(error)}`);
        return "ports-taken";
      }
      throw new Error(
        `Could not start '${containerName}': ${describeError(error)}. The container was left as it is; nothing was removed.`
      );
    }
    this.containerId = existing.Id;

    if (detach) {
      logger.info({ containerId: this.containerId }, "Container started");
      await this.fixMountPermissions(container);
      return { containerId: this.containerId, status: "running" };
    }
    return await this.runInteractive(container, { started: true });
  }

  /**
   * Snapshot a stopped container (`docker commit`) and move it aside, so a new
   * container with the same name can be created from the snapshot with the
   * current configuration and only the host ports that are free. Docker can't
   * change an existing container's ports; this keeps every file in it.
   */
  private async carryOver(
    existing: ContainerInfo,
    containerName: string,
    reason: string
  ): Promise<Carried> {
    const when = stamp();
    const tag = `${containerName}-${when}`.slice(0, 128);
    const snapshot = `${SNAPSHOT_REPO}:${tag}`;
    logger.warn(
      `Carrying '${containerName}' over to a new container: ${reason}. Its files are kept (snapshot ${snapshot}); a large container takes a while.`
    );
    const old = this.docker.getContainer(existing.Id);
    try {
      await old.commit({
        repo: SNAPSHOT_REPO,
        tag,
        pause: false,
        comment: `heretic: ${containerName} carried over (${reason})`,
      });
    } catch (error) {
      throw new Error(
        `Could not snapshot '${containerName}' to carry it over: ${describeError(error)}. Nothing was changed; the container is as it was.`
      );
    }
    const aside = `${containerName}-carried-${when}`;
    try {
      await old.rename({ name: aside });
    } catch (error) {
      await this.removeSnapshotQuietly(snapshot);
      throw new Error(
        `Could not move '${containerName}' aside to carry it over: ${describeError(error)}. Nothing was changed.`
      );
    }
    return { oldId: existing.Id, oldImage: existing.ImageID, aside, snapshot };
  }

  /** The new container could not be created: give the old one its name back. */
  private async undoCarry(carried: Carried, containerName: string): Promise<void> {
    try {
      await this.docker.getContainer(carried.oldId).rename({ name: containerName });
    } catch (error) {
      logger.warn(
        `Could not give '${carried.aside}' its name '${containerName}' back: ${describeError(error)}. Its files are in it, and in ${carried.snapshot}.`
      );
      return;
    }
    await this.removeSnapshotQuietly(carried.snapshot);
  }

  /** The new container exists: the old one, and a snapshot it ran from, can go. */
  private async finishCarry(carried: Carried): Promise<void> {
    try {
      await this.docker.getContainer(carried.oldId).remove({ force: true });
    } catch (error) {
      logger.warn(
        `The old container '${carried.aside}' could not be removed: ${describeError(error)}. Its files are in the new one too; remove it with: docker rm ${carried.aside}`
      );
      return;
    }
    await this.removeSnapshotQuietly(carried.oldImage);
    logger.info(`Carried over: the new container runs from ${carried.snapshot}`);
  }

  /**
   * The profile image was rebuilt: keep the old container's files in a
   * snapshot image, then remove it so a fresh container takes its name.
   */
  private async snapshotAndRemove(
    existing: ContainerInfo,
    containerName: string,
    reason: string
  ): Promise<void> {
    const tag = `${containerName}-${stamp()}`.slice(0, 128);
    const snapshot = `${SNAPSHOT_REPO}:${tag}`;
    logger.warn(
      `Replacing '${containerName}' with a fresh container: ${reason}. Its files are kept in ${snapshot}; a large container takes a while.`
    );
    const old = this.docker.getContainer(existing.Id);
    try {
      await old.commit({
        repo: SNAPSHOT_REPO,
        tag,
        pause: false,
        comment: `heretic: ${containerName} replaced (${reason})`,
      });
    } catch (error) {
      throw new Error(
        `Could not snapshot '${containerName}' before replacing it: ${describeError(error)}. Nothing was changed; pass --recreate to replace it without keeping its files.`
      );
    }
    await old.remove({ force: true });
    await this.removeSnapshotQuietly(existing.ImageID);
    logger.info(
      `The old files: docker run --rm -it --entrypoint bash ${snapshot} (remove with: docker rmi ${snapshot})`
    );
  }

  /** Remove a heretic snapshot image nothing uses any more; anything else is left. */
  private async removeSnapshotQuietly(image: string): Promise<void> {
    try {
      const handle = this.docker.getImage(image);
      const info = await handle.inspect();
      if (!(info.RepoTags || []).some((t: string) => t.startsWith(`${SNAPSHOT_REPO}:`))) return;
      await handle.remove();
    } catch {
      // still in use by a container, or already gone
    }
  }

  /**
   * Remove existing container with the same name if it exists
   */
  private async removeExistingContainer(containerName: string): Promise<void> {
    try {
      const existing = await findContainerByName(containerName, this.docker);

      if (existing) {
        logger.info({ containerName }, "Removing existing container");
        await stopContainer(existing.Id, { t: 5 }, this.docker).catch(() => {
          // Container might not be running, ignore stop errors
        });
        await removeContainer(existing.Id, { force: true }, this.docker);
      }
    } catch (error) {
      logger.debug({ error, containerName }, "Failed to check/remove existing container");
      // Continue anyway - the create will fail if there's a real conflict
    }
  }

  /**
   * Translate ResolvedAgentConfig to dockerode ContainerCreateOptions
   */
  private translateConfig(
    commandOverride?: string[],
    sidecarWiring?: SidecarWiring
  ): ContainerCreateOptions {
    const { config } = this;
    const extra = config.extra || {};

    // Translate command
    let cmd: string[] | undefined;
    if (commandOverride) {
      cmd = commandOverride;
    } else if (config.command) {
      cmd = Array.isArray(config.command) ? config.command : [config.command];
    }

    // Translate environment variables (start with resolved secrets, then overlay config.env)
    const rawEnvMap: Record<string, string> = {
      ...(config.secrets || {}),
      ...config.env,
    };

    // Filter and transform env vars for container
    const secretKeys = new Set(Object.keys(config.secrets || {}));
    const envKeys = new Set(Object.keys(config.env || {}));
    const envMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawEnvMap)) {
      // Skip keys that are in secrets but NOT in env (internal secret names)
      if (secretKeys.has(key) && !envKeys.has(key)) {
        continue;
      }
      // Rename ANTHROPIC_API_KEY to ANTHROPIC_AUTH_TOKEN + ANTHROPIC_AUTH_KEY for Claude Code
      if (key === "ANTHROPIC_API_KEY") {
        envMap["ANTHROPIC_AUTH_TOKEN"] = value;
        envMap["ANTHROPIC_AUTH_KEY"] = value;
      } else {
        envMap[key] = value;
      }
    }

    // Inject GitHub tokens from global settings
    try {
      const settings = loadSettings();
      if (settings.github?.token) {
        const ghToken = resolveToken(settings.github.token);
        envMap["GH_TOKEN"] = ghToken;
        envMap["GITHUB_TOKEN"] = ghToken;

        if (config.provider === "copilot") {
          const copilotToken = settings.github.copilot_token
            ? resolveToken(settings.github.copilot_token)
            : ghToken;
          envMap["GH_COPILOT_TOKEN"] = copilotToken;
          envMap["GITHUB_COPILOT_TOKEN"] = copilotToken;
        }
      }
    } catch (error) {
      logger.warn({ error }, "Failed to resolve GitHub tokens from settings");
    }

    // Per-agent git token overrides global settings
    if (config.git?.token) {
      envMap["GH_TOKEN"] = config.git.token;
      envMap["GITHUB_TOKEN"] = config.git.token;
    }

    // Filter out env vars with empty values to avoid overriding container defaults
    // Intentionally empty values (e.g. ANTHROPIC_AUTH_TOKEN="" for OAuth mode) are preserved
    // by checking if the key was explicitly set in config.env
    const intentionallyEmpty = new Set(
      Object.entries(config.env || {})
        .filter(([_, v]) => v === "")
        .map(([k]) => k)
    );
    for (const [key, value] of Object.entries(envMap)) {
      if (value === "" && !intentionallyEmpty.has(key)) {
        delete envMap[key];
      }
    }

    const env = Object.entries(envMap).map(([key, value]) => `${key}=${value}`);

    // Keep the container running as root (with /home/agent as HOME) when requested
    if (config.extra?.run_as_root) {
      env.push("HERETIC_RUN_AS_ROOT=1");
    }

    // Build-sidecar wiring: the agent resolves each builder by its network alias
    // (`http://builder-<runtime>:<port>`), so it must carry BUILD_SIDECARS and the
    // env passthrough allowlist and join the shared network (handled below).
    if (sidecarWiring) {
      env.push(`BUILD_SIDECARS=${sidecarWiring.buildSidecars}`);
      if (sidecarWiring.envPassthrough) {
        env.push(`SIDECAR_ENV_PASSTHROUGH=${sidecarWiring.envPassthrough}`);
      }
    }

    // Log env var names (not values for security)
    logger.info({ envVars: Object.keys(envMap) }, "Environment variables being set");
    // Debug: log env var values (masked) for troubleshooting
    for (const [key, value] of Object.entries(envMap)) {
      const masked = value.length > 4 ? value.slice(0, 4) + "****" : "****";
      logger.debug({ key, value: masked }, "Env var");
    }

    // Translate volumes
    const binds = config.volumes.map((vol) => {
      const readonly = vol.readonly ? ":ro" : "";
      return `${vol.source}:${vol.target}${readonly}`;
    });

    // run_as_root: mount the current (embedded) entrypoint over the image's
    // baked one so the flag works without rebuilding the image. The entrypoint
    // honors HERETIC_RUN_AS_ROOT to stay root with HOME=/home/agent.
    if (config.extra?.run_as_root) {
      const entrypointPath = this.writeEntrypointOverride();
      binds.push(`${entrypointPath}:/entrypoint.sh:ro`);
      logger.debug({ entrypointPath }, "Mounting run-as-root entrypoint override");
    }

    // SSH backend → SSH_* env, key/known_hosts binds, client overrides, host-gateway
    const sshSpec = prepareSshBackend(config);
    if (sshSpec) {
      for (const [key, value] of Object.entries(sshSpec.env)) {
        env.push(`${key}=${value}`);
      }
      appendBinds(binds, sshSpec.binds);
    }

    // MCP config → temp file + bind (skip if existing MCP config found in workspace unless override enabled)
    if (config.mcp && config.mcp.length > 0) {
      const existingMcpPath = getExistingMcpPath(config.agentType, config.projectDir);
      const shouldMount = config.mcpOverride || !hasUsableMcpConfig(existingMcpPath);

      if (shouldMount) {
        const mcpMountPaths = getMcpMountPaths(config.agentType);
        const sessionDir = ensureSessionDir(config.projectDir, config.sessionName);
        this.mcpFilePath = writeMcpFile(
          config.projectDir,
          config.mcp,
          sessionDir,
          config.agentType
        );
        for (const mountPath of mcpMountPaths) {
          binds.push(`${this.mcpFilePath}:${mountPath}`);
        }
      } else {
        logger.debug(
          { existingMcpPath },
          "Skipping MCP mount - existing MCP config found in workspace"
        );
      }
    }

    // Git config → env vars (GH_TOKEN/GITHUB_TOKEN already set in envMap above)
    if (config.git) {
      if (config.git.author_name) {
        env.push(`GIT_AUTHOR_NAME=${config.git.author_name}`);
      }
      if (config.git.author_email) {
        env.push(`GIT_AUTHOR_EMAIL=${config.git.author_email}`);
      }
    }

    // DinD → docker.sock bind, its group for the non-root agent, host workspace path
    let groupAdd: string[] | undefined;
    if (config.dind) {
      const dind = getDindWiring(config);
      binds.push(`${dind.source}:/var/run/docker.sock`);
      for (const [key, value] of Object.entries(dind.env)) {
        env.push(`${key}=${value}`);
      }
      if (dind.groupAdd.length > 0) groupAdd = dind.groupAdd;
      logger.info(
        `Docker-in-Docker: mounting ${dind.source} → /var/run/docker.sock` +
          (groupAdd ? ` (group ${groupAdd.join(",")})` : "")
      );
    }

    // Claude settings → merge to session dir as settings.json
    if (config.claudeSettings) {
      this.prepareClaudeSettings(config.claudeSettings);
    }

    // Mount session dir as agent home config directory (use agentType, not provider)
    const sessionDir = ensureSessionDir(config.projectDir, config.sessionName);
    if (config.agentType === "copilot-cli") {
      binds.push(`${sessionDir}:/home/agent/.copilot`);
      binds.push(`${sessionDir}:/root/.copilot`);
      logger.debug({ sessionDir }, "Mounting session dir as ~/.copilot");
    } else {
      // claude, aider, generic all use ~/.claude
      binds.push(`${sessionDir}:/home/agent/.claude`);
      binds.push(`${sessionDir}:/root/.claude`);
      logger.debug({ sessionDir }, "Mounting session dir as ~/.claude");

      // Seed .claude.json to skip onboarding/login screen
      const claudeJsonPath = join(sessionDir, ".claude.json");
      if (!existsSync(claudeJsonPath)) {
        writeFileSync(claudeJsonPath, JSON.stringify({ hasCompletedOnboarding: true }, null, 2));
        logger.debug("Seeded .claude.json with onboarding complete");
      }
      binds.push(`${claudeJsonPath}:/home/agent/.claude.json`);
      binds.push(`${claudeJsonPath}:/root/.claude.json`);
    }

    // Parse memory (e.g., "4g" -> bytes)
    let memory: number | undefined;
    if (extra.memory) {
      memory = this.parseMemory(extra.memory);
    }

    // Parse CPU (e.g., "2.0" -> nanoseconds)
    let nanoCpus: number | undefined;
    if (extra.cpus) {
      nanoCpus = this.parseCpus(extra.cpus);
    }

    // Parse shm_size
    let shmSize: number | undefined;
    if (extra.shm_size) {
      shmSize = this.parseMemory(extra.shm_size);
    }

    // Build labels
    const labels: Record<string, string> = {
      "heretic.managed": "true",
      "heretic.agent": this.config.name,
      "heretic.project": this.config.projectDir,
      "heretic.session": this.config.sessionName,
      ...(sidecarWiring ? { "heretic.network": sidecarWiring.networkName } : {}),
      ...(extra.labels || {}),
    };

    // Translate port bindings (ranges, remaps, bind IPs, protocols)
    const ports = extra.ports?.length ? toDockerPortConfig(extra.ports) : undefined;

    // Join the build-sidecar network so `builder-<runtime>` aliases resolve. A
    // user-pinned network_mode wins (the manager warned that siblings may be
    // unreachable in that case).
    const networkMode = extra.network || (sidecarWiring ? sidecarWiring.networkName : undefined);

    // Docker Desktop can't create a file mountpoint inside another bind (/workspace/.mcp.json)
    ensureNestedMountpoints(binds);

    const options: ContainerCreateOptions = {
      Image: config.image,
      Cmd: cmd,
      WorkingDir: config.workdir,
      Env: env,
      Labels: labels,
      ExposedPorts: ports?.exposedPorts,
      OpenStdin: config.interactive,
      Tty: config.tty,
      AttachStdin: config.interactive,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: binds,
        GroupAdd: groupAdd,
        NetworkMode: networkMode,
        PortBindings: ports?.portBindings,
        CapAdd: extra.capabilities,
        Privileged: extra.privileged,
        Memory: memory,
        NanoCpus: nanoCpus,
        ShmSize: shmSize,
        ExtraHosts: sshSpec?.extraHosts.length ? sshSpec.extraHosts : undefined,
      },
      User: extra.run_as_root ? "root" : extra.user,
      Hostname: extra.hostname,
    };

    return options;
  }

  /**
   * Write the embedded entrypoint to the session dir and return its host path.
   * Bind-mounted over the image's baked /entrypoint.sh so the run_as_root branch
   * works on images built before the feature existed.
   */
  private writeEntrypointOverride(): string {
    // Keep it OUT of the session dir: that dir is also bind-mounted as ~/.claude and
    // its .claude.json is file-mounted; an extra file bind from the same directory
    // makes Docker Desktop (virtiofs) mis-resolve mountpoints ("outside of rootfs").
    const dir = join(homedir(), ".heretic", "entrypoints");
    mkdirSync(dir, { recursive: true });
    const entrypointPath = join(dir, "entrypoint.sh");
    writeFileSync(entrypointPath, generateEntrypoint());
    chmodSync(entrypointPath, 0o755);
    return entrypointPath;
  }

  /**
   * Generate container name: heretic-<agent>-<session>-<hash8>
   */
  private generateContainerName(): string {
    return getAgentContainerName(this.config.name, this.config.sessionName, this.config.projectDir);
  }

  /**
   * Fix ownership of bind-mounted session directories so the container user can write.
   * Docker Desktop on macOS maps the host UID to root, so bind mounts appear as
   * root:root inside the container. This chowns them to the container's default user.
   */
  private async fixMountPermissions(container: Docker.Container): Promise<void> {
    const paths: string[] = [];
    if (this.config.agentType === "copilot-cli") {
      paths.push("/home/agent/.copilot", "/root/.copilot");
    } else {
      paths.push("/home/agent/.claude", "/root/.claude");
    }

    try {
      const exec = await container.exec({
        Cmd: ["chown", "-R", "agent:agent", ...paths],
        User: "root",
      });
      const stream = await exec.start({});
      // Wait for the chown to complete
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("error", resolve);
        stream.resume(); // drain the stream
      });
      logger.debug({ paths }, "Fixed mount permissions for container user");
    } catch (error) {
      logger.debug({ error }, "Failed to fix mount permissions (non-fatal)");
    }
  }

  /**
   * Run container in interactive mode, wait for exit
   */
  private async runInteractive(
    container: Docker.Container,
    options?: { started?: boolean }
  ): Promise<RunResult> {
    const { spawn } = await import("child_process");

    // Start container first (a resumed container is already started)
    if (!options?.started) {
      logger.info("Starting container...");
      await container.start();
    }
    logger.info({ containerId: this.containerId }, "Container started");

    // Fix ownership of bind-mounted session directories so the container user can write
    await this.fixMountPermissions(container);

    // Use docker attach command directly - more reliable for interactive TTY
    logger.info("Attaching to container...");

    return new Promise((resolve, reject) => {
      const dockerAttach = spawn("docker", ["attach", this.containerId!], {
        stdio: "inherit", // Inherit stdin, stdout, stderr directly
      });

      dockerAttach.on("error", (err) => {
        logger.error({ error: err }, "Failed to attach to container");
        reject(err);
      });

      dockerAttach.on("close", async (code) => {
        logger.info({ containerId: this.containerId, exitCode: code }, "Container session ended");

        // Get actual container exit code
        try {
          const info = await container.inspect();
          const exitCode = info.State.ExitCode;
          resolve({
            containerId: this.containerId!,
            exitCode,
            status: "exited",
          });
        } catch {
          resolve({
            containerId: this.containerId!,
            exitCode: code ?? 0,
            status: "exited",
          });
        }
      });
    });
  }

  /**
   * Parse memory string (e.g., "4g", "512m") to bytes
   */
  private parseMemory(memory: string): number {
    const match = memory.match(/^(\d+(?:\.\d+)?)(b|k|m|g)?$/i);
    if (!match) {
      throw new Error(`Invalid memory format: ${memory}`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || "b").toLowerCase();

    const multipliers: Record<string, number> = {
      b: 1,
      k: 1024,
      m: 1024 ** 2,
      g: 1024 ** 3,
    };

    return Math.floor(value * multipliers[unit]);
  }

  /**
   * Parse CPU value (e.g., "2.0", 2) to nanoseconds (for NanoCpus)
   */
  private parseCpus(cpus: string | number): number {
    const value = typeof cpus === "string" ? parseFloat(cpus) : cpus;
    if (isNaN(value)) {
      throw new Error(`Invalid CPU value: ${cpus}`);
    }
    return Math.floor(value * 1e9);
  }

  /**
   * Merge two claude settings objects
   * Arrays are unioned, objects are shallow merged (local wins)
   */
  private mergeClaudeSettings(
    global: Record<string, unknown>,
    local: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...global };

    for (const [key, localValue] of Object.entries(local)) {
      const globalValue = global[key];

      if (Array.isArray(localValue) && Array.isArray(globalValue)) {
        // Union arrays (deduplicate)
        result[key] = [...new Set([...globalValue, ...localValue])];
      } else if (
        localValue !== null &&
        typeof localValue === "object" &&
        !Array.isArray(localValue) &&
        globalValue !== null &&
        typeof globalValue === "object" &&
        !Array.isArray(globalValue)
      ) {
        // Shallow merge objects
        result[key] = {
          ...(globalValue as Record<string, unknown>),
          ...(localValue as Record<string, unknown>),
        };
      } else {
        // Replace primitives and mismatched types
        result[key] = localValue;
      }
    }

    return result;
  }

  /**
   * Prepare Claude settings file by merging global + local settings
   * Auto-detects local settings at .heretic/cli/claude-settings.json
   * Returns the temp file path or undefined if global doesn't exist
   */
  private prepareClaudeSettings(globalPath: string): string | undefined {
    // Expand ~ in global path
    const expandedGlobalPath = globalPath.startsWith("~")
      ? globalPath.replace("~", homedir())
      : globalPath;

    if (!existsSync(expandedGlobalPath)) {
      logger.warn(
        { globalPath: expandedGlobalPath },
        "Claude settings file not found, skipping mount"
      );
      return undefined;
    }

    // Check for local settings (auto-detect)
    const localPath = join(this.config.projectDir, ".heretic", "cli", "claude-settings.json");
    const hasLocalSettings = existsSync(localPath);

    // Write as settings.json in session dir (visible as ~/.claude/settings.json via dir mount)
    const sessionDir = ensureSessionDir(this.config.projectDir, this.config.sessionName);
    const tempPath = join(sessionDir, "settings.json");

    try {
      // Load global settings
      const globalContent = readFileSync(expandedGlobalPath, "utf-8");
      let settings = JSON.parse(globalContent) as Record<string, unknown>;

      // Merge with local if exists
      if (hasLocalSettings) {
        const localContent = readFileSync(localPath, "utf-8");
        const localSettings = JSON.parse(localContent) as Record<string, unknown>;
        settings = this.mergeClaudeSettings(settings, localSettings);
        logger.debug(
          { globalPath: expandedGlobalPath, localPath },
          "Merged global + local Claude settings"
        );
      } else {
        logger.debug(
          { globalPath: expandedGlobalPath },
          "Using global Claude settings (no local override)"
        );
      }

      writeFileSync(tempPath, JSON.stringify(settings, null, 2));
      return tempPath;
    } catch (error) {
      logger.error({ error, globalPath: expandedGlobalPath }, "Failed to prepare Claude settings");
      return undefined;
    }
  }

  /**
   * Handle and log errors with context
   */
  private handleError(error: unknown): void {
    const err = error as Record<string, unknown>;
    if (err.statusCode === 404) {
      logger.error({ error }, `Container or image not found: ${describeError(error)}`);
    } else if (err.statusCode === 409) {
      logger.error(
        { error },
        `Container conflict (name or port already in use): ${describeError(error)}`
      );
    } else if (err.errno === "EACCES") {
      logger.error(
        { error },
        "Permission denied. Try running with sudo or check Docker socket permissions."
      );
    } else if (err.errno === "ECONNREFUSED") {
      logger.error({ error }, "Cannot connect to Docker daemon");
    } else {
      logger.error({ error }, `Docker operation failed: ${describeError(error)}`);
    }
  }
}
