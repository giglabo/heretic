/**
 * Container reuse tests: config hashing, session ownership, and the docker
 * runner restarting a stopped session container instead of recreating it.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ContainerCreateOptions, ContainerInfo } from "dockerode";
import {
  CONFIG_HASH_LABEL,
  computeConfigHash,
  ownsSessionContainer,
} from "../src/utils/container-reuse";
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
  function setup(existing: { hash?: string; imageId?: string; project?: string }): {
    runner: DockerRunner;
    startExisting: ReturnType<typeof mock>;
    createContainer: ReturnType<typeof mock>;
  } {
    const runner = new DockerRunner(config);
    const name = getAgentContainerName(config.name, config.sessionName, projectDir);
    const startExisting = mock(async () => undefined);
    const created = { id: "new123", start: mock(async () => undefined) };
    const createContainer = mock(async () => created);
    const fakeContainer = {
      start: startExisting,
      stop: mock(async () => undefined),
      remove: mock(async () => undefined),
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
          },
        },
      ],
      getContainer: () => fakeContainer,
      createContainer,
    };
    return { runner, startExisting, createContainer };
  }

  function currentHash(): string {
    const options = (new DockerRunner(config) as any).translateConfig(undefined, undefined);
    return computeConfigHash(options);
  }

  test("restarts the stopped container when config and image are unchanged", async () => {
    const { runner, startExisting, createContainer } = setup({ hash: currentHash() });
    const result = await runner.start({ detach: true });
    expect(startExisting).toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(result.containerId).toBe("old123");
  });

  test("recreates when the config changed", async () => {
    const { runner, createContainer } = setup({ hash: "stale" });
    const result = await runner.start({ detach: true });
    expect(createContainer).toHaveBeenCalled();
    expect(result.containerId).toBe("new123");
    const opts = (createContainer.mock.calls[0] as any[])[0];
    expect(opts.Labels[CONFIG_HASH_LABEL]).toBe(currentHash());
  });

  test("recreates when the image was rebuilt", async () => {
    const { runner, createContainer } = setup({ hash: currentHash(), imageId: "sha256:old" });
    await runner.start({ detach: true });
    expect(createContainer).toHaveBeenCalled();
  });

  test("recreates a container from before reuse (no hash label)", async () => {
    const { runner, createContainer } = setup({});
    await runner.start({ detach: true });
    expect(createContainer).toHaveBeenCalled();
  });

  test("recreates a same-named container of another folder", async () => {
    const { runner, createContainer } = setup({ hash: currentHash(), project: "/elsewhere" });
    await runner.start({ detach: true });
    expect(createContainer).toHaveBeenCalled();
  });

  test("--recreate always creates a fresh container", async () => {
    const { runner, startExisting, createContainer } = setup({ hash: currentHash() });
    await runner.start({ detach: true, recreate: true });
    expect(createContainer).toHaveBeenCalled();
    expect(startExisting).not.toHaveBeenCalled();
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
