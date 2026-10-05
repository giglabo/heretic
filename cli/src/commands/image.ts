/**
 * `heretic-cli image build` and `heretic-cli image generate` commands.
 *
 * Builds Docker images for Heretic Agent containers using dynamically
 * generated Dockerfiles. Replaces the standalone build-heretic-agent scripts.
 */

import { Command } from "commander";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { getLogger, logRaw } from "../logger";
import { isDockerAvailable } from "../utils/docker";
import { SIDECAR_RUNTIMES, type SidecarRuntime } from "../types/agent-profile";
import {
  type ImageAgentType,
  type ImageBuildConfig,
  VALID_IMAGE_AGENTS,
  DEFAULT_BASE_IMAGE,
  defaultImageBuildConfig,
  generateDockerfile,
  generateEntrypoint,
  SIDECAR_EXEC_SCRIPT,
  SSH_EXEC_SCRIPT,
  EXEC_SERVER_MAIN_GO,
  EXEC_SERVER_GO_MOD,
  generateSidecarDockerfile,
  defaultSidecarRuntimeVersion,
  sidecarRuntimeTools,
  isSidecarRuntime,
} from "../templates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fullImageName(
  config: ImageBuildConfig,
  agentType: ImageAgentType,
  combinedMode: boolean
): string {
  let name = config.imageName;
  if (!combinedMode && agentType !== "claude") {
    name = `${config.imageName}-${agentType}`;
  }
  const tag = `${name}:${config.imageTag}`;
  return config.registry ? `${config.registry}/${tag}` : tag;
}

function getPlatforms(arch: string): string {
  switch (arch) {
    case "amd64":
    case "x86_64":
      return "linux/amd64";
    case "arm64":
    case "aarch64":
      return "linux/arm64";
    case "both":
    case "all":
      return "linux/amd64,linux/arm64";
    default:
      return "";
  }
}

function runCommand(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit", cwd });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

/**
 * Expand `--agent` values, validating and de-duplicating.
 */
function expandAgents(raw: string[]): ImageAgentType[] {
  if (raw.length === 0) return ["claude"];

  const expanded: ImageAgentType[] = [];
  for (const a of raw) {
    if (a === "all") {
      expanded.push(...VALID_IMAGE_AGENTS);
    } else if (VALID_IMAGE_AGENTS.includes(a as ImageAgentType)) {
      expanded.push(a as ImageAgentType);
    } else {
      throw new Error(`Invalid agent type '${a}'. Use: ${VALID_IMAGE_AGENTS.join(", ")}, or all`);
    }
  }
  return [...new Set(expanded)].sort() as ImageAgentType[];
}

/**
 * Map Commander.js options object to an ImageBuildConfig.
 */
function optionsToConfig(options: Record<string, unknown>): ImageBuildConfig {
  const config = defaultImageBuildConfig();

  // Agent types — Commander collects repeated --agent into an array
  const rawAgents = (options.agent as string[] | undefined) ?? [];
  config.agentTypes = expandAgents(rawAgents);
  config.combined = !!options.combined;

  // Image options
  if (options.name) config.imageName = options.name as string;
  if (options.tag) config.imageTag = options.tag as string;
  if (options.registry) config.registry = options.registry as string;
  config.doPush = !!options.push;
  // Commander auto-negates --no-cache: --cache defaults true, --no-cache sets false
  if (options.cache === false) config.noCache = true;
  config.dryRun = !!options.dryRun;

  // Architecture
  if (options.arch) config.arch = options.arch as string;

  // Base image
  if (options.base) config.baseImage = options.base as string;

  // Tool flags
  if (options.withAll) {
    config.withPython = true;
    config.withNode = true;
    config.withGo = true;
    config.withJava = true;
    config.withRust = true;
    config.withDocker = true;
    config.withGithubCli = true;
  }
  if (options.withPython) config.withPython = true;
  if (options.pythonVersion) {
    config.pythonVersion = options.pythonVersion as string;
    config.withPython = true;
  }
  if (options.withNode) config.withNode = true;
  if (options.nodeVersion) {
    config.nodeVersion = options.nodeVersion as string;
    config.withNode = true;
  }
  if (options.withGo) config.withGo = true;
  if (options.goVersion) {
    config.goVersion = options.goVersion as string;
    config.withGo = true;
  }
  if (options.withJava) config.withJava = true;
  if (options.javaVersion) {
    config.javaVersion = options.javaVersion as string;
    config.withJava = true;
  }
  if (options.withRust) config.withRust = true;
  if (options.rustVersion) {
    config.rustVersion = options.rustVersion as string;
    config.withRust = true;
  }
  if (options.withDocker) config.withDocker = true;
  // --with-github-cli defaults true; allow explicit --no-github-cli
  if (options.githubCli === false) config.withGithubCli = false;

  // Agent user
  if (options.agentUser) config.agentUser = options.agentUser as string;
  if (options.agentUid) config.agentUid = Number(options.agentUid);
  if (options.agentGid) config.agentGid = Number(options.agentGid);

  return config;
}

// ---------------------------------------------------------------------------
// Build logic
// ---------------------------------------------------------------------------

function printConfig(
  config: ImageBuildConfig,
  agentType: ImageAgentType,
  combinedMode: boolean
): void {
  const name = fullImageName(config, agentType, combinedMode);
  const label = combinedMode ? config.agentTypes.join(", ") : agentType;

  logRaw(`\n=== Building ${label} Agent ===\n`);
  logRaw("Configuration:");
  logRaw(`  Agent type(s):  ${label}`);
  logRaw(`  Image name:     ${name}`);
  logRaw(`  Base image:     ${config.baseImage}`);
  logRaw(`  Architecture:   ${config.arch || "current platform"}`);
  logRaw(`  Push:           ${config.doPush}`);
  logRaw("");
  logRaw("Tools:");
  logRaw(`  Python:         ${config.withPython ? config.pythonVersion : "false"}`);
  if (config.baseImage.startsWith("node:")) {
    logRaw("  Node.js:        included in base");
  } else {
    logRaw(
      `  Node.js:        ${config.withNode ? config.nodeVersion + ".x" : "auto (required for CLIs)"}`
    );
  }
  logRaw(`  Go:             ${config.withGo ? config.goVersion : "false"}`);
  logRaw(`  Java:           ${config.withJava ? config.javaVersion : "false"}`);
  logRaw(`  Rust:           ${config.withRust ? config.rustVersion : "false"}`);
  logRaw(`  Docker CLI:     ${config.withDocker}`);
  logRaw(`  GitHub CLI:     ${config.withGithubCli}`);
  logRaw("  Tool backends:  sidecar-exec, ssh-exec (runtime wrappers)");
  logRaw("");
}

async function prepareBuildDir(
  config: ImageBuildConfig,
  agentType: ImageAgentType,
  combinedMode: boolean
): Promise<string> {
  const buildDir = await mkdtemp(join(tmpdir(), "heretic-build-"));

  const dockerfile = generateDockerfile(config, agentType, combinedMode);
  await writeFile(join(buildDir, "Dockerfile"), dockerfile);

  const entrypoint = generateEntrypoint();
  await writeFile(join(buildDir, "entrypoint.sh"), entrypoint);
  await chmod(join(buildDir, "entrypoint.sh"), 0o755);

  // Sidecar exec client (routes wrapped commands to an HTTP build sidecar)
  await writeFile(join(buildDir, "sidecar-exec"), SIDECAR_EXEC_SCRIPT);
  await chmod(join(buildDir, "sidecar-exec"), 0o755);

  // SSH exec script
  await writeFile(join(buildDir, "ssh-exec"), SSH_EXEC_SCRIPT);
  await chmod(join(buildDir, "ssh-exec"), 0o755);

  return buildDir;
}

async function buildSingleImage(
  config: ImageBuildConfig,
  agentType: ImageAgentType,
  combinedMode: boolean
): Promise<void> {
  printConfig(config, agentType, combinedMode);

  const buildDir = await prepareBuildDir(config, agentType, combinedMode);

  try {
    if (config.dryRun) {
      logRaw("=== Generated Dockerfile ===");
      const { readFile } = await import("node:fs/promises");
      const df = await readFile(join(buildDir, "Dockerfile"), "utf-8");
      logRaw(df);
      logRaw("=== Generated entrypoint.sh ===");
      const ep = await readFile(join(buildDir, "entrypoint.sh"), "utf-8");
      logRaw(ep);
      return;
    }

    const imageName = fullImageName(config, agentType, combinedMode);
    const platforms = getPlatforms(config.arch);

    const buildArgs = [
      "--build-arg",
      `BASE_IMAGE=${config.baseImage}`,
      "--build-arg",
      `AGENT_USER=${config.agentUser}`,
      "--build-arg",
      `AGENT_UID=${config.agentUid}`,
      "--build-arg",
      `AGENT_GID=${config.agentGid}`,
      "--build-arg",
      `AGENT_TYPE=${combinedMode ? "combined" : agentType}`,
      "--tag",
      imageName,
    ];

    if (config.noCache) {
      buildArgs.push("--no-cache");
    }

    if (platforms) {
      buildArgs.push("--platform", platforms);
      if (config.doPush) {
        logRaw("Mode: buildx with push");
        await runCommand(
          "docker",
          ["buildx", "build", ...buildArgs, "--push", "-f", "Dockerfile", "."],
          buildDir
        );
      } else {
        logRaw("Mode: buildx local");
        await runCommand(
          "docker",
          ["buildx", "build", ...buildArgs, "--load", "-f", "Dockerfile", "."],
          buildDir
        );
      }
    } else {
      logRaw("Mode: standard build (current platform)");
      await runCommand("docker", ["build", ...buildArgs, "-f", "Dockerfile", "."], buildDir);

      if (config.doPush && config.registry) {
        logRaw("Pushing image...");
        await runCommand("docker", ["push", imageName]);
      }
    }

    logRaw(`\nBuild complete: ${imageName}\n`);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Command: image build
// ---------------------------------------------------------------------------

async function runImageBuild(options: Record<string, unknown>): Promise<void> {
  const logger = getLogger();
  const config = optionsToConfig(options);

  // Pre-flight: check Docker unless --dry-run
  if (!config.dryRun) {
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      logger.error(
        "Docker is not available. Install Docker or use --dry-run to preview the Dockerfile."
      );
      process.exit(1);
    }
  }

  logRaw("=== Heretic Agent Image Builder ===\n");

  if (config.combined && config.agentTypes.length > 1) {
    await buildSingleImage(config, config.agentTypes[0], true);
    const name = fullImageName(config, config.agentTypes[0], true);
    logRaw("Usage examples:");
    for (const agent of config.agentTypes) {
      logRaw(`  docker run -it --rm -e AGENT_TYPE=${agent} ${name}`);
    }
    logRaw("");
  } else if (config.agentTypes.length > 1) {
    logRaw(`Building ${config.agentTypes.length} agent types: ${config.agentTypes.join(", ")}`);
    for (const agent of config.agentTypes) {
      logRaw("\n==================================================");
      await buildSingleImage(config, agent, false);
      logRaw("==================================================\n");
    }
    logRaw(`All ${config.agentTypes.length} agent images built successfully!\n`);
    logRaw("Built images:");
    for (const agent of config.agentTypes) {
      logRaw(`  - ${fullImageName(config, agent, false)}`);
    }
  } else {
    const agent = config.agentTypes[0];
    await buildSingleImage(config, agent, false);

    if (!config.dryRun) {
      const name = fullImageName(config, agent, false);
      logRaw("Usage examples:");
      logRaw("  # Interactive mode");
      logRaw(`  docker run -it --rm ${name}`);
      logRaw("");
      logRaw("  # Workflow mode (the baked ENTRYPOINT switches to it when PROMPT_FILE is set)");
      logRaw("  docker run -it --rm \\");
      logRaw("    -e PROMPT_FILE=/workspace/prompt.md \\");
      logRaw("    -e REPO_PATH=/workspace \\");
      logRaw("    -v $(pwd):/workspace \\");
      logRaw(`    ${name}`);
      logRaw("");
    }
  }
}

// ---------------------------------------------------------------------------
// Command: image generate
// ---------------------------------------------------------------------------

type GenerateFormat =
  | "dockerfile"
  | "entrypoint"
  | "ssh-exec"
  | "sidecar-exec"
  | "sidecar-dockerfile"
  | "exec-server";

async function runImageGenerate(options: Record<string, unknown>): Promise<void> {
  const format = (options.format as string) ?? "dockerfile";
  const validFormats: GenerateFormat[] = [
    "dockerfile",
    "entrypoint",
    "ssh-exec",
    "sidecar-exec",
    "sidecar-dockerfile",
    "exec-server",
  ];

  if (!validFormats.includes(format as GenerateFormat)) {
    const logger = getLogger();
    logger.error(`Invalid format '${format}'. Use: ${validFormats.join(", ")}`);
    process.exit(1);
  }

  switch (format as GenerateFormat) {
    case "dockerfile": {
      const config = optionsToConfig(options);
      const agent = config.agentTypes[0];
      const combined = config.combined && config.agentTypes.length > 1;
      logRaw(generateDockerfile(config, agent, combined));
      break;
    }
    case "entrypoint":
      logRaw(generateEntrypoint());
      break;
    case "ssh-exec":
      logRaw(SSH_EXEC_SCRIPT);
      break;
    case "sidecar-exec":
      logRaw(SIDECAR_EXEC_SCRIPT);
      break;
    case "sidecar-dockerfile": {
      const runtime = (options.runtime as string) ?? "node";
      if (!isSidecarRuntime(runtime)) {
        const logger = getLogger();
        logger.error(
          `Invalid sidecar runtime '${runtime}'. Use one of: ${SIDECAR_RUNTIMES.join(", ")}`
        );
        process.exit(1);
      }
      logRaw(
        generateSidecarDockerfile({
          runtime,
          runtimeVersion: options.runtimeVersion as string | undefined,
          goBuilderImage: options.goBuilder as string | undefined,
          port: options.port ? Number(options.port) : undefined,
        })
      );
      break;
    }
    case "exec-server":
      logRaw(EXEC_SERVER_MAIN_GO);
      break;
  }
}

// ---------------------------------------------------------------------------
// Command: image build-sidecar <runtime>
// ---------------------------------------------------------------------------

interface SidecarBuildConfig {
  runtime: SidecarRuntime;
  imageName: string;
  imageTag: string;
  registry: string;
  runtimeVersion?: string;
  goBuilder?: string;
  port?: number;
  doPush: boolean;
  noCache: boolean;
  dryRun: boolean;
  arch: string;
}

function sidecarImageName(config: SidecarBuildConfig): string {
  const tag = `${config.imageName}:${config.imageTag}`;
  return config.registry ? `${config.registry}/${tag}` : tag;
}

function sidecarOptionsToConfig(
  runtime: SidecarRuntime,
  options: Record<string, unknown>
): SidecarBuildConfig {
  return {
    runtime,
    imageName: (options.name as string) || `heretic-builder-${runtime}`,
    imageTag: (options.tag as string) || "latest",
    registry: (options.registry as string) || "",
    runtimeVersion: options.runtimeVersion as string | undefined,
    goBuilder: options.goBuilder as string | undefined,
    port: options.port ? Number(options.port) : undefined,
    doPush: !!options.push,
    noCache: options.cache === false,
    dryRun: !!options.dryRun,
    arch: (options.arch as string) || "",
  };
}

/**
 * Lay out a build context for a builder image:
 *   <dir>/Dockerfile
 *   <dir>/exec-server/{main.go,go.mod}
 * The Dockerfile's build stage compiles the vendored exec-server from there.
 */
async function prepareSidecarBuildDir(config: SidecarBuildConfig): Promise<string> {
  const buildDir = await mkdtemp(join(tmpdir(), "heretic-builder-"));

  const dockerfile = generateSidecarDockerfile({
    runtime: config.runtime,
    runtimeVersion: config.runtimeVersion,
    goBuilderImage: config.goBuilder,
    port: config.port,
  });
  await writeFile(join(buildDir, "Dockerfile"), dockerfile);

  const srcDir = join(buildDir, "exec-server");
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "main.go"), EXEC_SERVER_MAIN_GO);
  await writeFile(join(srcDir, "go.mod"), EXEC_SERVER_GO_MOD);

  return buildDir;
}

function printSidecarConfig(config: SidecarBuildConfig): void {
  const version = config.runtimeVersion || defaultSidecarRuntimeVersion(config.runtime);
  logRaw(`\n=== Building ${config.runtime} build-sidecar ===\n`);
  logRaw("Configuration:");
  logRaw(`  Runtime:        ${config.runtime} (${sidecarRuntimeTools(config.runtime)})`);
  logRaw(`  Image name:     ${sidecarImageName(config)}`);
  logRaw(`  Runtime ver.:   ${version}`);
  logRaw(`  Architecture:   ${config.arch || "current platform"}`);
  logRaw(`  Push:           ${config.doPush}`);
  logRaw("  Server:         Go exec-server (/health, /info, /exec, /exec/stream)");
  logRaw("");
}

async function runImageBuildSidecar(
  runtimeArg: string,
  options: Record<string, unknown>
): Promise<void> {
  const logger = getLogger();

  if (!isSidecarRuntime(runtimeArg)) {
    logger.error(
      `Invalid sidecar runtime '${runtimeArg}'. Use one of: ${SIDECAR_RUNTIMES.join(", ")}`
    );
    process.exit(1);
  }

  const config = sidecarOptionsToConfig(runtimeArg, options);

  if (!config.dryRun) {
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      logger.error(
        "Docker is not available. Install Docker or use --dry-run to preview the Dockerfile."
      );
      process.exit(1);
    }
  }

  logRaw("=== Heretic Build-Sidecar Image Builder ===\n");
  printSidecarConfig(config);

  const buildDir = await prepareSidecarBuildDir(config);

  try {
    if (config.dryRun) {
      logRaw("=== Generated Dockerfile ===");
      logRaw(
        generateSidecarDockerfile({
          runtime: config.runtime,
          runtimeVersion: config.runtimeVersion,
          goBuilderImage: config.goBuilder,
          port: config.port,
        })
      );
      return;
    }

    const imageName = sidecarImageName(config);
    const platforms = getPlatforms(config.arch);

    const buildArgs: string[] = [];
    if (config.runtimeVersion) {
      buildArgs.push("--build-arg", `RUNTIME_VERSION=${config.runtimeVersion}`);
    }
    if (config.goBuilder) {
      buildArgs.push("--build-arg", `GO_BUILDER_IMAGE=${config.goBuilder}`);
    }
    buildArgs.push("--tag", imageName);
    if (config.noCache) {
      buildArgs.push("--no-cache");
    }

    if (platforms) {
      buildArgs.push("--platform", platforms);
      if (config.doPush) {
        logRaw("Mode: buildx with push");
        await runCommand(
          "docker",
          ["buildx", "build", ...buildArgs, "--push", "-f", "Dockerfile", "."],
          buildDir
        );
      } else {
        logRaw("Mode: buildx local");
        await runCommand(
          "docker",
          ["buildx", "build", ...buildArgs, "--load", "-f", "Dockerfile", "."],
          buildDir
        );
      }
    } else {
      logRaw("Mode: standard build (current platform)");
      await runCommand("docker", ["build", ...buildArgs, "-f", "Dockerfile", "."], buildDir);
      if (config.doPush && config.registry) {
        logRaw("Pushing image...");
        await runCommand("docker", ["push", imageName]);
      }
    }

    logRaw(`\nBuild complete: ${imageName}\n`);
    logRaw("Use it in a profile:");
    logRaw("  tool_backends:");
    logRaw("    sidecars:");
    logRaw(`      - runtime: ${config.runtime}`);
    logRaw(`        image: ${imageName}`);
    logRaw("");
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shared Commander options (reused by build and generate)
// ---------------------------------------------------------------------------

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option(
      "--agent <type>",
      "Agent type: claude, copilot, opencode, gemini, all (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--combined", "Install all specified agents in a single image")
    .option("--base <image>", `Base image (default: ${DEFAULT_BASE_IMAGE})`)
    .option("--with-python", "Include Python 3, pip, poetry, pytest, black, ruff, mypy")
    .option("--python-version <ver>", "Python version: 3.11, 3.12, 3.13 (default: 3.13)")
    .option("--with-node", "Include Node.js (npm, yarn, pnpm)")
    .option("--node-version <ver>", "Node.js version: 18, 20, 22 (default: 22)")
    .option("--with-go", "Include Go compiler and toolchain")
    .option("--go-version <ver>", "Go version (default: 1.23.4)")
    .option("--with-java", "Include Java (Eclipse Temurin), Maven, Gradle")
    .option("--java-version <ver>", "Java version: 11, 17, 21 (default: 21)")
    .option("--with-rust", "Include Rust, Cargo")
    .option("--rust-version <ver>", "Rust version: stable, nightly, beta (default: stable)")
    .option("--with-docker", "Include Docker CLI (for DinD/DooD)")
    .option("--with-github-cli", "Include GitHub CLI (gh) — enabled by default")
    .option("--no-github-cli", "Exclude GitHub CLI")
    .option("--with-all", "Enable ALL built-in tools")
    .option("--agent-user <user>", "Agent username (default: agent)")
    .option("--agent-uid <uid>", "Agent user ID (default: 1000)")
    .option("--agent-gid <gid>", "Agent group ID (default: 1000)");
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createImageCommand(): Command {
  const image = new Command("image");
  image.description("Build and generate Heretic Agent Docker images");

  // --- build subcommand ---
  const buildCmd = new Command("build");
  buildCmd.description("Build a Heretic Agent Docker image");
  addSharedOptions(buildCmd);
  buildCmd
    .option("-n, --name <name>", "Image name (default: heretic-agent)")
    .option("-t, --tag <tag>", "Image tag (default: latest)")
    .option("-r, --registry <reg>", "Registry prefix (e.g., ghcr.io/username)")
    .option("-p, --push", "Push image after build")
    .option("--no-cache", "Build without Docker cache")
    .option("--dry-run", "Print Dockerfile and exit without building")
    .option("-a, --arch <arch>", "Architecture: amd64, arm64, or both (default: current)")
    .action(async (options) => {
      await runImageBuild(options);
    });
  image.addCommand(buildCmd);

  // --- build-sidecar subcommand ---
  const buildSidecarCmd = new Command("build-sidecar");
  buildSidecarCmd
    .description("Build a build-sidecar image (Go exec-server + runtime toolchain)")
    .argument("<runtime>", `Runtime: ${SIDECAR_RUNTIMES.join(", ")}`)
    .option("-n, --name <name>", "Image name (default: heretic-builder-<runtime>)")
    .option("-t, --tag <tag>", "Image tag (default: latest)")
    .option("-r, --registry <reg>", "Registry prefix (e.g., ghcr.io/username)")
    .option("--runtime-version <ver>", "Runtime toolchain version (e.g. node 22, python 3.13)")
    .option("--go-builder <image>", "Golang image for the exec-server build stage")
    .option("--port <port>", "exec-server port baked into the image (default: 8080)")
    .option("-p, --push", "Push image after build")
    .option("--no-cache", "Build without Docker cache")
    .option("--dry-run", "Print Dockerfile and exit without building")
    .option("-a, --arch <arch>", "Architecture: amd64, arm64, or both (default: current)")
    .action(async (runtime, options) => {
      await runImageBuildSidecar(runtime, options);
    });
  image.addCommand(buildSidecarCmd);

  // --- generate subcommand ---
  const generateCmd = new Command("generate");
  generateCmd.description(
    "Output a generated template to stdout (Dockerfile, entrypoint, or resource scripts)"
  );
  addSharedOptions(generateCmd);
  generateCmd
    .option(
      "--format <format>",
      "Template to output: dockerfile, entrypoint, ssh-exec, sidecar-exec, sidecar-dockerfile, exec-server (default: dockerfile)"
    )
    .option(
      "--runtime <runtime>",
      `Sidecar runtime for sidecar-dockerfile (${SIDECAR_RUNTIMES.join(", ")})`
    )
    .option("--runtime-version <ver>", "Runtime version for sidecar-dockerfile")
    .option("--go-builder <image>", "Golang build-stage image for sidecar-dockerfile")
    .option("--port <port>", "exec-server port for sidecar-dockerfile")
    .action(async (options) => {
      await runImageGenerate(options);
    });
  image.addCommand(generateCmd);

  return image;
}
