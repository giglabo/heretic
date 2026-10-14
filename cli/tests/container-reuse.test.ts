/**
 * Container reuse tests: config hashing, session ownership, and the docker
 * runner restarting a stopped session container instead of recreating it.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ContainerCreateOptions, ContainerInfo } from "dockerode";
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
  summarizePorts,
} from "../src/utils/container-reuse";
import { errorText } from "../src/logger";
import { DockerRunner } from "../src/runners/docker-runner";
import { findContainerByNameOrId } from "../src/commands/attach";
import { getAgentContainerName } from "../src/utils/session";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";

describe("computeConfigHash", () => {
  const base: ContainerCreateOptions = {
    Image: "img:latest",
    Env: ["A=1", "B=2"],
    Labels: { "heretic.agent": "a" },
    HostConfig: { Binds: ["/x:/x", "/y:/y"] },
  };

  test("ignores env/bind order and the hash label itself", () => {
    const reordered: ContainerCreateOptions = {
      ...base,
      Env: ["B=2", "A=1"],
      Labels: { "heretic.agent": "a", [CONFIG_HASH_LABEL]: "old" },
      HostConfig: { Binds: ["/y:/y", "/x:/x"] },
    };
    expect(computeConfigHash(reordered)).toBe(computeConfigHash(base));
  });

  test("changes when env, image, mounts or user change", () => {
    const hash = computeConfigHash(base);
    expect(computeConfigHash({ ...base, Env: ["A=1", "B=3"] })).not.toBe(hash);
    expect(computeConfigHash({ ...base, Image: "img:other" })).not.toBe(hash);
    expect(computeConfigHash({ ...base, HostConfig: { Binds: ["/x:/x"] } })).not.toBe(hash);
    expect(computeConfigHash({ ...base, User: "root" })).not.toBe(hash);
  });
});

describe("ownsSessionContainer", () => {
  const identity = { name: "claude", projectDir: "/p", sessionName: "default" };
  const labels = {
    "heretic.managed": "true",
    "heretic.agent": "claude",
    "heretic.project": "/p",
    "heretic.session": "default",
  };

  test("matches profile + folder + session", () => {
    expect(ownsSessionContainer(labels, identity)).toBe(true);
  });

  test("rejects another folder, session, profile or a sidecar", () => {
    expect(ownsSessionContainer({ ...labels, "heretic.project": "/q" }, identity)).toBe(false);
    expect(ownsSessionContainer({ ...labels, "heretic.session": "two" }, identity)).toBe(false);
    expect(ownsSessionContainer({ ...labels, "heretic.agent": "claude-zai" }, identity)).toBe(
      false
    );
    expect(ownsSessionContainer({ ...labels, "heretic.role": "build-sidecar" }, identity)).toBe(
      false
    );
    expect(ownsSessionContainer(undefined, identity)).toBe(false);
  });
});

describe("DockerRunner container reuse", () => {
  let projectDir: string;
  let config: ResolvedAgentConfig;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "heretic-reuse-test-"));
    config = {
      name: "test-agent",
      image: "ubuntu:latest",
      runner: "docker",
      agentType: "claude",
      provider: "anthropic",
      projectDir,
      sessionName: "default",
      volumes: [{ source: projectDir, target: "/workspace", readonly: false }],
      env: { TEST_VAR: "v" },
      workdir: "/workspace",
      command: ["/bin/bash"],
      tty: true,
      interactive: true,
      extra: {},
      dind: false,
      mcpOverride: false,
    };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** A runner over a fake Docker holding one stopped session container. */
  function setup(existing: {
    hash?: string;
    imageId?: string;
    baseImage?: string;
    project?: string;
    exposedPorts?: Record<string, object>;
    portBindings?: Record<string, Array<{ HostIp?: string; HostPort: string }>>;
    startError?: Error;
    newStartError?: Error;
  }) {
    const runner = new DockerRunner(config);
    const name = getAgentContainerName(config.name, config.sessionName, projectDir);
    const startExisting = mock(async () => {
      if (existing.startError) throw existing.startError;
    });
    const created = {
      id: "new123",
      start: mock(async () => {
        if (existing.newStartError) throw existing.newStartError;
      }),
    };
    const createContainer = mock(async () => created);
    const commit = mock(async () => ({ Id: "sha256:snap" }));
    const rename = mock(async () => undefined);
    const remove = mock(async () => undefined);
    const fakeContainer = {
      start: startExisting,
      stop: mock(async () => undefined),
      remove,
      commit,
      rename,
      inspect: async () => ({
        Config: { ExposedPorts: existing.exposedPorts },
        HostConfig: { PortBindings: existing.portBindings ?? {} },
      }),
      exec: mock(async () => {
        throw new Error("no exec in tests");
      }),
    };
    (runner as any).docker = {
      ping: async () => "OK",
      listImages: async () => [{ Id: "sha256:img", RepoTags: ["ubuntu:latest"] }],
      listContainers: async () => [
        {
          Id: "old123",
          Names: [`/${name}`],
          State: "exited",
          ImageID: existing.imageId ?? "sha256:img",
          Labels: {
            "heretic.managed": "true",
            "heretic.agent": config.name,
            "heretic.project": existing.project ?? projectDir,
            "heretic.session": config.sessionName,
            ...(existing.hash ? { [CONFIG_HASH_LABEL]: existing.hash } : {}),
            ...(existing.baseImage ? { [BASE_IMAGE_LABEL]: existing.baseImage } : {}),
          },
        },
      ],
      getContainer: () => fakeContainer,
      getImage: () => ({
        inspect: async () => ({ RepoTags: ["ubuntu:latest"] }),
        remove: mock(async () => undefined),
      }),
      createContainer,
    };
    return { runner, startExisting, createContainer, commit, rename, remove, created };
  }

  function currentOptions(): any {
    return (new DockerRunner(config) as any).translateConfig(undefined, undefined);
  }

  function currentHash(): string {
    return computeConfigHash(currentOptions());
  }

  /** A host port held by something else for the test's duration. */
  async function holdPort(): Promise<{ port: number; server: Server }> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
    return { port: (server.address() as { port: number }).port, server };
  }

  /** A host port nothing holds. */
  async function freePort(): Promise<number> {
    const { port, server } = await holdPort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  test("restarts the stopped container when config and image are unchanged", async () => {
    const { runner, startExisting, createContainer } = setup({ hash: currentHash() });
    const result = await runner.start({ detach: true });
    expect(startExisting).toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(result.containerId).toBe("old123");
  });

  test("carries a container whose configuration changed over, with its files", async () => {
    const { runner, createContainer, commit, rename, remove } = setup({ hash: "stale" });
    const result = await runner.start({ detach: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(result.containerId).toBe("new123");
    const opts = (createContainer.mock.calls[0] as any[])[0];
    expect(opts.Image.startsWith(`${SNAPSHOT_REPO}:`)).toBe(true);
    expect(opts.Labels[CONFIG_HASH_LABEL]).toBe(currentHash());
    expect(opts.Labels[BASE_IMAGE_LABEL]).toBe("sha256:img");
    // the old container goes only once the new one exists
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("replaces a container whose profile image was rebuilt, keeping its files in a snapshot", async () => {
    const { runner, createContainer, commit, remove } = setup({
      hash: currentHash(),
      imageId: "sha256:old",
    });
    await runner.start({ detach: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    const opts = (createContainer.mock.calls[0] as any[])[0];
    expect(opts.Image).toBe("ubuntu:latest");
  });

  test("a carried-over container's base image is its label, not its snapshot", async () => {
    const { runner, startExisting, commit } = setup({
      hash: currentHash(),
      imageId: "sha256:snap-of-it",
      baseImage: "sha256:img",
    });
    await runner.start({ detach: true });
    expect(startExisting).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("carries over a container from before reuse (no hash label)", async () => {
    const { runner, createContainer, commit } = setup({});
    await runner.start({ detach: true });
    expect(commit).toHaveBeenCalledTimes(1);
    const opts = (createContainer.mock.calls[0] as any[])[0];
    expect(opts.Image.startsWith(`${SNAPSHOT_REPO}:`)).toBe(true);
  });

  test("never touches a same-named container of another folder", async () => {
    const { runner, createContainer, commit, remove } = setup({
      hash: currentHash(),
      project: "/elsewhere",
    });
    await expect(runner.start({ detach: true })).rejects.toThrow(/left alone/);
    expect(createContainer).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("a host port taken by something else is no reason to throw a container away", async () => {
    const { port, server } = await holdPort();
    try {
      const exposed = { [`${port}/tcp`]: {} };
      const created = { [`${port}/tcp`]: [{ HostPort: String(port) }] };
      const stored = legacyConfigHashes(currentOptions(), exposed, created)[0];
      const { runner, startExisting, createContainer, commit } = setup({
        hash: stored,
        exposedPorts: exposed,
        // docker inspect fills in the bind IP heretic left out
        portBindings: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] },
      });
      const result = await runner.start({ detach: true });
      expect(startExisting).not.toHaveBeenCalled();
      expect(commit).toHaveBeenCalledTimes(1);
      expect(result.containerId).toBe("new123");
      const opts = (createContainer.mock.calls[0] as any[])[0];
      expect(opts.Image.startsWith(`${SNAPSHOT_REPO}:`)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a container made before ports left the hash starts as it is when its ports are free", async () => {
    const port = await freePort();
    const exposed = { [`${port}/tcp`]: {} };
    const created = { [`${port}/tcp`]: [{ HostPort: String(port) }] };
    const stored = legacyConfigHashes(currentOptions(), exposed, created)[0];
    const { runner, startExisting, createContainer, commit } = setup({
      hash: stored,
      exposedPorts: exposed,
      portBindings: { [`${port}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: String(port) }] },
    });
    await runner.start({ detach: true });
    expect(startExisting).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
  });

  test("Docker refusing a taken port carries the container over", async () => {
    const refusal = Object.assign(
      new Error(
        "(HTTP code 500) server error - failed to set up container networking: Bind for 0.0.0.0:1313 failed: port is already allocated"
      ),
      { statusCode: 500 }
    );
    const { runner, createContainer, commit } = setup({ hash: currentHash(), startError: refusal });
    const result = await runner.start({ detach: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(createContainer).toHaveBeenCalled();
    expect(result.containerId).toBe("new123");
  });

  test("any other refusal leaves the container as it is and says why", async () => {
    const { runner, createContainer, commit, remove } = setup({
      hash: currentHash(),
      startError: new Error("mount source path does not exist"),
    });
    await expect(runner.start({ detach: true })).rejects.toThrow(
      /mount source path does not exist.*left as it is/
    );
    expect(createContainer).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("a failure after a carry-over keeps the new container for the next run", async () => {
    const { runner, remove } = setup({
      hash: "stale",
      newStartError: new Error("could not start"),
    });
    await expect(runner.start({ detach: true })).rejects.toThrow(/could not start/);
    // the old container, once; never the new one holding the files
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("--recreate always creates a fresh container", async () => {
    const { runner, startExisting, createContainer, commit } = setup({ hash: currentHash() });
    await runner.start({ detach: true, recreate: true });
    expect(createContainer).toHaveBeenCalled();
    expect(startExisting).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("decideReuse", () => {
  const base = {
    owned: true,
    baseImage: "sha256:img",
    imageId: "sha256:img",
    storedHash: "h",
    hash: "h",
    busyPorts: [] as string[],
  };

  test("unchanged with free ports: reuse", () => {
    expect(decideReuse(base).kind).toBe("reuse");
  });

  test("unchanged with busy ports: carry, naming them", () => {
    const d = decideReuse({ ...base, busyPorts: ["1313", "3000"] });
    expect(d.kind).toBe("carry");
    expect((d as { reason: string }).reason).toContain("1313, 3000");
  });

  test("an old container's hash matches with its own ports put back", () => {
    expect(decideReuse({ ...base, storedHash: "old", legacyHashes: ["old"] }).kind).toBe("reuse");
  });

  test("config changed or no hash: carry; image rebuilt: snapshot; not ours: refuse", () => {
    expect(decideReuse({ ...base, storedHash: "other" }).kind).toBe("carry");
    expect(decideReuse({ ...base, storedHash: undefined }).kind).toBe("carry");
    expect(decideReuse({ ...base, imageId: "sha256:new" }).kind).toBe("snapshot-and-replace");
    expect(decideReuse({ ...base, owned: false }).kind).toBe("refuse");
  });
});

describe("ports and the config hash", () => {
  test("the published ports are not part of the hash", () => {
    const options = {
      Image: "img",
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: { Binds: ["/x:/x"], PortBindings: { "3000/tcp": [{ HostPort: "3000" }] } },
      Labels: { a: "b" },
    };
    const without = {
      Image: "img",
      HostConfig: { Binds: ["/x:/x"] },
      Labels: { a: "b", [BASE_IMAGE_LABEL]: "sha256:x" },
    };
    expect(computeConfigHash(options as any)).toBe(computeConfigHash(without as any));
  });

  test("hostPortsOf reads Docker's bindings", () => {
    expect(
      hostPortsOf({
        "1313/tcp": [{ HostIp: "0.0.0.0", HostPort: "1313" }],
        "5353/udp": [{ HostPort: "5353" }],
        "9/tcp": [{ HostPort: "" }],
      })
    ).toEqual([
      { port: 1313, protocol: "tcp", hostIp: "0.0.0.0" },
      { port: 5353, protocol: "udp", hostIp: undefined },
    ]);
    expect(hostPortsOf(null)).toEqual([]);
  });

  test("a long port list stays readable", () => {
    const ports = Array.from({ length: 12 }, (_, i) => String(3000 + i));
    expect(summarizePorts(ports)).toBe("3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007 and 4 more");
  });
});

describe("Docker's errors are said, not dropped", () => {
  const dockerError = Object.assign(
    new Error("(HTTP code 500) server error - port is already allocated"),
    {
      json: {
        message:
          "failed to set up container networking: Bind for 0.0.0.0:1313 failed: port is already allocated",
      },
    }
  );

  test("describeError and errorText give Docker's own sentence", () => {
    expect(describeError(dockerError)).toContain("Bind for 0.0.0.0:1313 failed");
    expect(errorText(dockerError)).toContain("Bind for 0.0.0.0:1313 failed");
    expect(describeError(new Error("(HTTP code 404) no such container - gone"))).toBe("gone");
    expect(errorText(undefined)).toBe("");
  });

  test("a taken port is recognised", () => {
    expect(isPortConflict(dockerError)).toBe(true);
    expect(isPortConflict(new Error("no such image"))).toBe(false);
  });
});

describe("attach: three profiles in one folder", () => {
  const here = "/work/app";
  const agent = (profile: string, session: string, dir: string, id: string): ContainerInfo =>
    ({
      Id: id,
      Names: [`/${getAgentContainerName(profile, session, dir)}`],
      State: "running",
      Labels: {
        "heretic.managed": "true",
        "heretic.agent": profile,
        "heretic.project": dir,
        "heretic.session": session,
      },
    }) as unknown as ContainerInfo;

  const containers = [
    agent("claude-zai", "default", here, "zai1"),
    agent("claude", "default", "/work/other", "other1"),
    agent("claude", "default", here, "claude1"),
    agent("claude", "review", here, "claude2"),
    agent("copilot", "default", here, "cop1"),
  ];

  test("picks the profile's own container in this folder", () => {
    expect(findContainerByNameOrId("claude", containers, here)?.Id).toBe("claude1");
    expect(findContainerByNameOrId("claude-zai", containers, here)?.Id).toBe("zai1");
    expect(findContainerByNameOrId("copilot", containers, here)?.Id).toBe("cop1");
    expect(findContainerByNameOrId("claude", containers, here, "review")?.Id).toBe("claude2");
  });

  test("never falls through to a similarly named profile or another folder", () => {
    const onlyZai = [containers[0], containers[1]];
    expect(findContainerByNameOrId("claude", onlyZai, here)).toBeUndefined();
    expect(findContainerByNameOrId("claude", containers, "/work/other")?.Id).toBe("other1");
  });
});
