/**
 * Unit tests for the SSH backend wiring: presets, validation, the runner spec
 * and the pure `ssh setup` helpers.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";
import {
  DEFAULT_SSH_PRESETS,
  SSH_PRESETS,
  expandSshCommands,
  isDockerHostTarget,
  resolveSshHostName,
  validateSshCommands,
} from "../src/utils/ssh-presets";
import {
  appendBinds,
  bindTarget,
  buildSshBackendSpec,
  resolveWorkspaceTarget,
} from "../src/runners/ssh-backend";
import {
  buildAuthorizedKeysLine,
  buildKnownHostsLines,
  detectPresets,
  findCommandsOnPath,
  hasAuthorizedKey,
  knownHostsPattern,
  macProtectedFolder,
  parseCapturedPath,
  selectPresets,
} from "../src/utils/ssh-host";
import { validateResolvedConfig } from "../src/utils/config-resolver";
import { validateProfile } from "../src/utils/profile-loader";

const base = (over: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig => ({
  name: "p",
  projectDir: "/home/me/proj",
  sessionName: "default",
  image: "img:latest",
  runner: "docker",
  agentType: "claude",
  provider: "anthropic",
  volumes: [{ source: "/home/me/proj", target: "/workspace" }],
  env: {},
  workdir: "/workspace",
  command: [],
  interactive: false,
  tty: false,
  extra: {},
  dind: false,
  mcpOverride: false,
  ...over,
});

describe("ssh presets", () => {
  test("rust and node presets cover the core toolchain commands", () => {
    expect(SSH_PRESETS.rust).toEqual(expect.arrayContaining(["cargo", "rustc", "rustup"]));
    expect(SSH_PRESETS.node).toEqual(expect.arrayContaining(["npm", "pnpm", "yarn", "node"]));
  });

  test("defaults to the five runtime presets when nothing is listed", () => {
    const cmds = expandSshCommands({});
    for (const preset of DEFAULT_SSH_PRESETS) {
      for (const c of SSH_PRESETS[preset]) expect(cmds).toContain(c);
    }
    expect(cmds).not.toContain("docker");
  });

  test("explicit commands alone disable the default presets", () => {
    expect(expandSshCommands({ commands: ["xcrun"] })).toEqual(["xcrun"]);
  });

  test("dedupes and drops denied or malformed names", () => {
    const cmds = expandSshCommands({
      presets: ["rust"],
      commands: ["cargo", "bash", "a;b", "make"],
    });
    expect(cmds.filter((c) => c === "cargo")).toHaveLength(1);
    expect(cmds).not.toContain("bash");
    expect(cmds).not.toContain("a;b");
    expect(cmds).toContain("make");
  });

  test("validation reports unknown presets, denied and malformed commands", () => {
    const errors = validateSshCommands({
      presets: ["rust", "cobol" as never],
      commands: ["ssh", "ok", "rm -rf"],
    });
    expect(errors.some((e) => e.includes("unknown preset 'cobol'"))).toBe(true);
    expect(errors.some((e) => e.includes("'ssh' can never be routed"))).toBe(true);
    expect(errors.some((e) => e.includes("invalid command name 'rm -rf'"))).toBe(true);
    expect(errors).toHaveLength(3);
  });

  test("docker-host alias", () => {
    expect(isDockerHostTarget("docker-host")).toBe(true);
    expect(isDockerHostTarget("host.docker.internal")).toBe(true);
    expect(isDockerHostTarget("build.example.com")).toBe(false);
    expect(resolveSshHostName("docker-host")).toBe("host.docker.internal");
    expect(resolveSshHostName("build.example.com")).toBe("build.example.com");
  });
});

describe("ssh config validation", () => {
  test("resolved config: numeric ranges, absolute known_hosts, env names", () => {
    const errors = validateResolvedConfig(
      base({
        ssh: {
          host: "h",
          known_hosts: "relative/kh",
          connect_timeout: 0,
          control_persist: -1,
          max_sessions: 100,
          env_passthrough: ["OK", "NOT-OK"],
        },
      })
    );
    expect(errors).toContain("ssh.known_hosts must be an absolute path: relative/kh");
    expect(errors).toContain("ssh.connect_timeout must be a positive integer");
    expect(errors).toContain("ssh.control_persist must be a non-negative integer");
    expect(errors).toContain("ssh.max_sessions must be an integer between 1 and 64");
    expect(errors).toContain("ssh.env_passthrough: invalid variable name 'NOT-OK'");
  });

  test("profile: field types", () => {
    const errors = validateProfile({
      image: "i",
      ssh: { host: "h", presets: "rust", probe: "yes", max_sessions: "8" },
    });
    expect(errors).toContain("Profile field 'ssh.presets' must be an array of strings");
    expect(errors).toContain("Profile field 'ssh.probe' must be a boolean");
    expect(errors).toContain("Profile field 'ssh.max_sessions' must be a number");
  });
});

describe("buildSshBackendSpec", () => {
  test("undefined without an ssh block", () => {
    expect(buildSshBackendSpec(base())).toBeUndefined();
  });

  test("remote host: explicit fields, no host-gateway, no implicit host cwd", () => {
    const spec = buildSshBackendSpec(
      base({
        ssh: {
          host: "build.example.com",
          port: 2200,
          key_path: "/k",
          known_hosts: "/kh",
          presets: ["rust"],
          env_passthrough: ["CI", "NODE_ENV"],
          connect_timeout: 5,
          control_persist: 0,
          max_sessions: 4,
          probe: false,
          tty: true,
          host_run: false,
        },
      })
    )!;
    expect(spec.env).toMatchObject({
      SSH_HOST: "build.example.com",
      SSH_PORT: "2200",
      SSH_USER: "agent",
      SSH_KEY_PATH: "/etc/heretic/ssh/key",
      SSH_KNOWN_HOSTS: "/etc/heretic/ssh/known_hosts",
      SSH_WORKSPACE: "/workspace",
      SSH_LOGIN_SHELL: "1",
      SSH_ENV_PASSTHROUGH: "CI NODE_ENV",
      SSH_CONNECT_TIMEOUT: "5",
      SSH_CONTROL_PERSIST: "0",
      SSH_MAX_SESSIONS: "4",
      SSH_PROBE: "0",
      SSH_TTY: "1",
      SSH_HOST_RUN: "0",
    });
    expect(spec.env.SSH_COMMANDS.split(" ")).toEqual([...SSH_PRESETS.rust]);
    expect(spec.env.SSH_HOST_CWD).toBeUndefined();
    expect(spec.binds).toEqual([
      "/k:/etc/heretic/ssh/key:ro",
      "/kh:/etc/heretic/ssh/known_hosts:ro",
    ]);
    expect(spec.extraHosts).toEqual([]);
  });

  test("docker-host: host-gateway + project dir as host cwd + current user", () => {
    const spec = buildSshBackendSpec(base({ ssh: { host: "docker-host" } }))!;
    expect(spec.env.SSH_HOST).toBe("host.docker.internal");
    expect(spec.env.SSH_HOST_CWD).toBe("/home/me/proj");
    expect(spec.env.SSH_USER).not.toBe("");
    expect(spec.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
  });

  test("host_path disables the login shell unless asked for", () => {
    const a = buildSshBackendSpec(base({ ssh: { host: "h", host_path: "/bin" } }))!;
    expect(a.env.SSH_HOST_PATH).toBe("/bin");
    expect(a.env.SSH_LOGIN_SHELL).toBeUndefined();
    const b = buildSshBackendSpec(
      base({ ssh: { host: "h", host_path: "/bin", login_shell: true } })
    )!;
    expect(b.env.SSH_LOGIN_SHELL).toBe("1");
  });

  test("client files are bound over the image's copies", () => {
    const spec = buildSshBackendSpec(base({ ssh: { host: "h" } }), {
      sshExec: "/x/ssh-exec",
      entrypoint: "/x/entrypoint.sh",
    })!;
    expect(spec.binds).toContain("/x/ssh-exec:/opt/sidecar/ssh-exec:ro");
    expect(spec.binds).toContain("/x/entrypoint.sh:/entrypoint.sh:ro");
  });

  test("workspace target follows the project volume, then workdir", () => {
    expect(
      resolveWorkspaceTarget(base({ volumes: [{ source: "/home/me/proj", target: "/src" }] }))
    ).toBe("/src");
    expect(resolveWorkspaceTarget(base({ volumes: [], workdir: "/w" }))).toBe("/w");
    expect(resolveWorkspaceTarget(base({ volumes: [], workdir: "" }))).toBe("/workspace");
  });
});

describe("bind helpers", () => {
  test("bindTarget handles modes and Windows drive letters", () => {
    expect(bindTarget("/a:/b:ro")).toBe("/b");
    expect(bindTarget("/a:/b")).toBe("/b");
    expect(bindTarget("C:\\Users\\me\\k:/etc/heretic/ssh/key:ro")).toBe("/etc/heretic/ssh/key");
  });

  test("appendBinds skips targets that are already mounted", () => {
    const binds = ["/one/entrypoint.sh:/entrypoint.sh:ro"];
    appendBinds(binds, ["/two/entrypoint.sh:/entrypoint.sh:ro", "/k:/etc/heretic/ssh/key:ro"]);
    expect(binds).toEqual(["/one/entrypoint.sh:/entrypoint.sh:ro", "/k:/etc/heretic/ssh/key:ro"]);
  });
});

describe("ssh setup helpers", () => {
  const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample heretic-p";

  test("authorized_keys line is restricted and idempotent", () => {
    const line = buildAuthorizedKeysLine(pub, "heretic-p", "172.16.0.0/12");
    expect(line).toBe(
      'restrict,pty,from="172.16.0.0/12" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample heretic-p'
    );
    expect(hasAuthorizedKey(`other\n${line}\n`, pub)).toBe(true);
    expect(hasAuthorizedKey("ssh-ed25519 AAAAdifferent x\n", pub)).toBe(false);
  });

  test("known_hosts lines from .pub files and keyscan output", () => {
    expect(knownHostsPattern("host.docker.internal", 22)).toBe("host.docker.internal");
    expect(knownHostsPattern("host.docker.internal", 2222)).toBe("[host.docker.internal]:2222");
    const lines = buildKnownHostsLines("host.docker.internal", 22, [
      "ssh-ed25519 AAAAhost root@machine\n",
      "# comment\n10.0.0.1 ecdsa-sha2-nistp256 AAAAecdsa\n",
    ]);
    expect(lines).toEqual([
      "host.docker.internal ssh-ed25519 AAAAhost",
      "host.docker.internal ecdsa-sha2-nistp256 AAAAecdsa",
    ]);
  });

  test("captured PATH survives banners and motd noise", () => {
    expect(parseCapturedPath("Welcome!\n__HERETIC_PATH__/a:/b__HERETIC_PATH__\nbye")).toBe("/a:/b");
    expect(parseCapturedPath("no markers")).toBeUndefined();
  });

  test("findCommandsOnPath only reports executables", () => {
    const dir = mkdtempSync(join(tmpdir(), "heretic-ssh-path-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "cargo"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "cargo"), 0o755);
    writeFileSync(join(dir, "bin", "npm"), "not executable");
    chmodSync(join(dir, "bin", "npm"), 0o644);
    const found = findCommandsOnPath(["cargo", "npm", "go"], join(dir, "bin"));
    expect(found).toEqual(process.platform === "win32" ? ["cargo", "npm"] : ["cargo"]);
  });

  test("preset auto-selection skips container and vcs", () => {
    const picked = selectPresets(detectPresets(["cargo", "npm", "git", "docker"]));
    expect(picked).toEqual(["node", "rust"]);
  });

  test("macOS protected folders", () => {
    expect(macProtectedFolder("/Users/me/Documents/app", "/Users/me")).toBe("/Users/me/Documents");
    expect(macProtectedFolder("/Users/me/code/app", "/Users/me")).toBeUndefined();
  });
});
