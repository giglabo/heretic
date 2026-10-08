/**
 * SSH backend command presets and host helpers.
 *
 * The SSH backend routes a command to the host only when (a) it is listed —
 * via `ssh.presets` and/or `ssh.commands` — and (b) it is NOT installed in the
 * container. The container always wins. The expanded list reaches the image
 * entrypoint as `SSH_COMMANDS`.
 */

import type { SshConfig, SshPreset } from "../types/agent-profile";

/** Commands each preset routes to the host. */
export const SSH_PRESETS: Record<SshPreset, readonly string[]> = {
  node: ["npm", "npx", "pnpm", "yarn", "node", "corepack", "bun"],
  python: ["python", "python3", "pip", "pip3", "poetry", "pytest", "ruff", "black", "mypy", "uv"],
  java: ["java", "javac", "mvn", "gradle"],
  go: ["go", "gofmt"],
  rust: ["cargo", "rustc", "rustfmt", "rustup", "clippy", "cargo-clippy"],
  dotnet: ["dotnet", "msbuild", "nuget"],
  apple: ["xcrun", "xcodebuild", "swift", "swiftc", "pod", "xcode-select"],
  build: ["make", "cmake", "ninja", "just", "bazel"],
  container: ["docker", "docker-compose", "kubectl", "helm"],
  vcs: ["git", "gh"],
};

export const SSH_PRESET_NAMES = Object.keys(SSH_PRESETS) as SshPreset[];

/** One-line descriptions for `heretic-cli ssh presets`. */
export const SSH_PRESET_DESCRIPTIONS: Record<SshPreset, string> = {
  node: "Node.js package managers and runtime",
  python: "Python interpreters, pip/poetry/uv and linters",
  java: "JDK, Maven and Gradle",
  go: "Go toolchain",
  rust: "Cargo, rustc, rustup and lints",
  dotnet: ".NET SDK",
  apple: "Xcode command-line tools, Swift, CocoaPods (macOS hosts)",
  build: "Generic build tools",
  container: "Docker / Kubernetes CLIs — root-equivalent on the host",
  vcs: "git / gh — usually installed in the container, so rarely routed",
};

/** Presets applied when the `ssh:` block names neither presets nor commands. */
export const DEFAULT_SSH_PRESETS: readonly SshPreset[] = ["node", "python", "java", "go", "rust"];

/**
 * Commands that are never routed over SSH: the shell, ssh itself, privilege
 * tools and the agent CLIs. Wrapping any of them would hand the agent's own
 * process (or the transport) to the host. Mirrored in entrypoint.sh.
 */
export const SSH_DENIED_COMMANDS: readonly string[] = [
  "ssh",
  "scp",
  "sftp",
  "ssh-agent",
  "ssh-add",
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "env",
  "sudo",
  "su",
  "exec",
  "nohup",
  "timeout",
  "claude",
  "copilot",
  "opencode",
  "gemini",
  "aider",
  "heretic-cli",
  "ssh-exec",
  "sidecar-exec",
];

/** Valid command token (it becomes a file name and part of a heredoc). */
export const SSH_COMMAND_PATTERN = /^[A-Za-z0-9._+-]+$/;

/** `ssh.host` value that means "the machine running Docker". */
export const DOCKER_HOST_ALIAS = "docker-host";

/** Hostname the container uses to reach the Docker host. */
export const DOCKER_HOST_NAME = "host.docker.internal";

/** True when the SSH target is the Docker host itself. */
export function isDockerHostTarget(host: string | undefined): boolean {
  return host === DOCKER_HOST_ALIAS || host === DOCKER_HOST_NAME;
}

/** Hostname to put in SSH_HOST (resolves the `docker-host` alias). */
export function resolveSshHostName(host: string): string {
  return host === DOCKER_HOST_ALIAS ? DOCKER_HOST_NAME : host;
}

/**
 * Expand presets + explicit commands into the ordered, de-duplicated list
 * exported as SSH_COMMANDS. Denied and malformed names are dropped (validation
 * reports them separately).
 */
export function expandSshCommands(ssh: Pick<SshConfig, "presets" | "commands">): string[] {
  const presets =
    ssh.presets === undefined && ssh.commands === undefined
      ? DEFAULT_SSH_PRESETS
      : (ssh.presets ?? []);

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (cmd: string): void => {
    if (seen.has(cmd) || !SSH_COMMAND_PATTERN.test(cmd) || SSH_DENIED_COMMANDS.includes(cmd)) {
      return;
    }
    seen.add(cmd);
    out.push(cmd);
  };

  for (const preset of presets) {
    for (const cmd of SSH_PRESETS[preset] ?? []) add(cmd);
  }
  for (const cmd of ssh.commands ?? []) add(cmd);
  return out;
}

/** Validation errors for the preset/command fields of an `ssh:` block. */
export function validateSshCommands(ssh: Pick<SshConfig, "presets" | "commands">): string[] {
  const errors: string[] = [];
  for (const preset of ssh.presets ?? []) {
    if (!SSH_PRESET_NAMES.includes(preset)) {
      errors.push(
        `ssh.presets: unknown preset '${preset}' (valid: ${SSH_PRESET_NAMES.join(", ")})`
      );
    }
  }
  for (const cmd of ssh.commands ?? []) {
    if (!SSH_COMMAND_PATTERN.test(cmd)) {
      errors.push(`ssh.commands: invalid command name '${cmd}'`);
    } else if (SSH_DENIED_COMMANDS.includes(cmd)) {
      errors.push(`ssh.commands: '${cmd}' can never be routed over SSH`);
    }
  }
  return errors;
}
