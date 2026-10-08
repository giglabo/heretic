/**
 * Tests for the dockerode-native SidecarManager (Phase 4).
 *
 * These exercise the pure spec-building methods (no Docker daemon): the agent
 * wiring, the per-builder container create options, and workspace-bind
 * resolution. Lifecycle (start/stop/teardown) needs a live daemon and is not
 * covered here.
 */

import { describe, test, expect } from "bun:test";
import {
  SidecarManager,
  SIDECAR_ROLE_LABEL,
  SIDECAR_ROLE_VALUE,
} from "../src/runners/sidecar-manager";
import type { ResolvedAgentConfig, ToolBackends } from "../src/types/agent-profile";

function baseConfig(toolBackends?: ToolBackends): ResolvedAgentConfig {
  return {
    name: "test-agent",
    projectDir: "/host/project",
    sessionName: "default",
    image: "test-image:latest",
    runner: "docker",
    agentType: "claude",
    provider: "anthropic",
    volumes: [{ source: "/host/project", target: "/workspace", readonly: false }],
    env: {},
    workdir: "/workspace",
    command: [],
    tty: false,
    interactive: false,
    extra: {},
    dind: false,
    mcpOverride: false,
    toolBackends,
  };
}

// The pure methods never touch the client; a stub is enough.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDocker = {} as any;

function mgr(toolBackends?: ToolBackends): SidecarManager {
  return new SidecarManager(baseConfig(toolBackends), fakeDocker);
}

describe("SidecarManager.hasSidecars", () => {
  test("false without sidecars, true with", () => {
    expect(mgr().hasSidecars()).toBe(false);
    expect(mgr({ sidecars: [] }).hasSidecars()).toBe(false);
    expect(mgr({ sidecars: [{ runtime: "node", image: "n:latest" }] }).hasSidecars()).toBe(true);
  });
});

describe("SidecarManager.computeWiring", () => {
  test("produces BUILD_SIDECARS in the normative shape", () => {
    const wiring = mgr({
      sidecars: [
        { runtime: "node", image: "n:latest" },
        { runtime: "python", image: "p:latest", port: 9000 },
      ],
    }).computeWiring();
    expect(JSON.parse(wiring.buildSidecars)).toEqual({
      node: { internal_url: "http://builder-node:8080" },
      python: { internal_url: "http://builder-python:9000" },
    });
  });

  test("unions env_passthrough across sidecars", () => {
    const wiring = mgr({
      sidecars: [
        { runtime: "node", image: "n:latest", env_passthrough: ["NPM_TOKEN"] },
        { runtime: "python", image: "p:latest", env_passthrough: ["PIP_INDEX_URL", "NPM_TOKEN"] },
      ],
    }).computeWiring();
    const names = wiring.envPassthrough.split(",");
    expect(names).toContain("NPM_TOKEN");
    expect(names).toContain("PIP_INDEX_URL");
    expect(names.length).toBe(2);
  });

  test("network name is stable and scoped to agent/session/project", () => {
    const wiring = mgr({ sidecars: [{ runtime: "go", image: "g:latest" }] }).computeWiring();
    expect(wiring.networkName).toMatch(/^heretic-net-test-agent-default-[a-f0-9]{8}$/);
    // Deterministic across instances (same project dir → same hash).
    const again = mgr({ sidecars: [{ runtime: "go", image: "g:latest" }] }).computeWiring();
    expect(again.networkName).toBe(wiring.networkName);
  });
});

describe("SidecarManager.buildBuilderCreateOptions", () => {
  test("shares the workspace bind and runs the default exec-server command", () => {
    const m = mgr({ sidecars: [{ runtime: "node", image: "heretic-builder-node:latest" }] });
    const opts = m.buildBuilderCreateOptions({
      runtime: "node",
      image: "heretic-builder-node:latest",
    });
    expect(opts.Image).toBe("heretic-builder-node:latest");
    expect(opts.WorkingDir).toBe("/workspace");
    expect(opts.Cmd).toEqual(["exec-server", "-port", "8080", "-cwd", "/workspace"]);
    expect(opts.HostConfig?.Binds).toContain("/host/project:/workspace");
  });

  test("hardened posture: cap_drop ALL, no-new-privileges, no published ports", () => {
    const m = mgr({ sidecars: [{ runtime: "node", image: "n:latest" }] });
    const opts = m.buildBuilderCreateOptions({ runtime: "node", image: "n:latest" });
    expect(opts.HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(opts.HostConfig?.SecurityOpt).toContain("no-new-privileges:true");
    expect(opts.HostConfig?.PortBindings).toBeUndefined();
    expect(opts.HostConfig?.RestartPolicy).toEqual({ Name: "no" });
  });

  test("joins the shared network with a builder-<runtime> alias", () => {
    const m = mgr({ sidecars: [{ runtime: "python", image: "p:latest" }] });
    const opts = m.buildBuilderCreateOptions({ runtime: "python", image: "p:latest" });
    const net = m.buildNetworkName();
    expect(opts.HostConfig?.NetworkMode).toBe(net);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = (opts.NetworkingConfig as any)?.EndpointsConfig;
    expect(endpoints[net].Aliases).toEqual(["builder-python"]);
  });

  test("runs as the caller uid by default, with sidecar labels", () => {
    const m = mgr({ sidecars: [{ runtime: "node", image: "n:latest" }] });
    const opts = m.buildBuilderCreateOptions({ runtime: "node", image: "n:latest" });
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    expect(opts.User).toBe(`${uid}:${gid}`);
    expect(opts.Labels?.[SIDECAR_ROLE_LABEL]).toBe(SIDECAR_ROLE_VALUE);
    expect(opts.Labels?.["heretic.runtime"]).toBe("node");
    expect(opts.Labels?.["heretic.network"]).toBe(m.buildNetworkName());
    expect(opts.Labels?.["heretic.managed"]).toBe("true");
  });

  test("run_as_caller_uid:false omits the User override", () => {
    const m = mgr({ run_as_caller_uid: false, sidecars: [{ runtime: "node", image: "n:latest" }] });
    const opts = m.buildBuilderCreateOptions({ runtime: "node", image: "n:latest" });
    expect(opts.User).toBeUndefined();
  });

  test("sets a writable HOME and the resolved port in the builder env", () => {
    const m = mgr({ sidecars: [{ runtime: "rust", image: "r:latest", port: 7000 }] });
    const opts = m.buildBuilderCreateOptions({ runtime: "rust", image: "r:latest", port: 7000 });
    expect(opts.Env).toContain("HOME=/workspace/.heretic-home/rust");
    expect(opts.Env).toContain("EXEC_SERVER_PORT=7000");
    expect(opts.Cmd).toEqual(["exec-server", "-port", "7000", "-cwd", "/workspace"]);
  });

  test("mounts named cache volumes", () => {
    const m = mgr({
      sidecars: [
        {
          runtime: "node",
          image: "n:latest",
          cache_volumes: ["heretic-cache-node:/home/agent/.npm"],
        },
      ],
    });
    const opts = m.buildBuilderCreateOptions({
      runtime: "node",
      image: "n:latest",
      cache_volumes: ["heretic-cache-node:/home/agent/.npm"],
    });
    expect(opts.HostConfig?.Binds).toContain("heretic-cache-node:/home/agent/.npm");
  });

  test("respects a command override", () => {
    const m = mgr({ sidecars: [{ runtime: "node", image: "n:latest" }] });
    const opts = m.buildBuilderCreateOptions({
      runtime: "node",
      image: "n:latest",
      command: ["/usr/local/bin/serve", "--port", "8080"],
    });
    expect(opts.Cmd).toEqual(["/usr/local/bin/serve", "--port", "8080"]);
  });

  test("honors a custom workspace_target", () => {
    const config = baseConfig({
      workspace_target: "/code",
      sidecars: [{ runtime: "go", image: "g:latest" }],
    });
    config.volumes = [{ source: "/host/code", target: "/code", readonly: false }];
    const m = new SidecarManager(config, fakeDocker);
    const opts = m.buildBuilderCreateOptions({ runtime: "go", image: "g:latest" });
    expect(opts.WorkingDir).toBe("/code");
    expect(opts.HostConfig?.Binds).toContain("/host/code:/code");
    expect(opts.Cmd).toEqual(["exec-server", "-port", "8080", "-cwd", "/code"]);
  });
});

describe("SidecarManager.resolveWorkspaceBind", () => {
  test("throws a clear error when no volume targets the workspace", () => {
    const config = baseConfig({ sidecars: [{ runtime: "node", image: "n:latest" }] });
    config.volumes = [{ source: "/host/x", target: "/somewhere-else", readonly: false }];
    const m = new SidecarManager(config, fakeDocker);
    expect(() => m.resolveWorkspaceBind()).toThrow(/no volume targets '\/workspace'/);
  });
});
