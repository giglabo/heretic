/**
 * Docker Runner Example
 *
 * Demonstrates using the DockerRunner (single-container mode) and the
 * low-level Docker utilities to manage containers directly.
 *
 * DockerRunner is the default runner — it creates a single container
 * via dockerode and optionally attaches stdin/stdout for interactive use.
 */

import { DockerRunner } from "../src/runners/docker-runner";
import { createRunner } from "../src/runners";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";
import {
  isDockerAvailable,
  pullImage,
  listContainers,
  stopContainer,
  removeContainer,
} from "../src/utils/docker";

// Example: Minimal agent configuration using the Docker runner
const minimalConfig: ResolvedAgentConfig = {
  name: "my-agent",
  image: "giglabo/claude-heretic:latest",
  runner: "docker",
  agentType: "claude",
  provider: "anthropic",
  projectDir: "/workspace/my-project",
  sessionName: "default",

  volumes: [
    {
      source: "/workspace/my-project",
      target: "/workspace",
      readonly: false,
    },
  ],

  env: {
    NODE_ENV: "development",
  },

  workdir: "/workspace",
  command: [],
  tty: true,
  interactive: true,
  mcpOverride: false,
  dind: false,
  extra: {},
};

// Example: Agent with SSH, MCP, Git, and resource limits
const fullConfig: ResolvedAgentConfig = {
  name: "full-agent",
  image: "giglabo/claude-heretic:latest",
  runner: "docker",
  agentType: "claude",
  provider: "anthropic",
  projectDir: "/workspace/my-project",
  sessionName: "dev-session",

  volumes: [
    {
      source: "/workspace/my-project",
      target: "/workspace",
      readonly: false,
    },
    {
      source: "/home/user/.config",
      target: "/home/agent/.config",
      readonly: true,
    },
  ],

  env: {
    NODE_ENV: "development",
  },

  workdir: "/workspace",
  command: [],
  tty: true,
  interactive: true,
  mcpOverride: false,
  dind: true, // Mount docker.sock for Docker-in-Docker

  extra: {
    memory: "4g",
    cpus: "2.0",
    shm_size: "2g",
    ports: ["3000:3000", "8080:8080"],
    labels: {
      team: "platform",
    },
  },

  ssh: {
    host: "dev-server.example.com",
    port: 22,
    user: "agent",
  },

  mcp: [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@anthropic/mcp-server-filesystem", "/workspace"],
    },
  ],

  git: {
    author_name: "Dev Agent",
    author_email: "agent@example.com",
  },

  secrets: {
    ANTHROPIC_API_KEY: "sk-ant-xxxxx",
  },
};

// Example: Using the DockerRunner
async function runDockerAgent(): Promise<void> {
  // Check Docker availability first
  if (!(await isDockerAvailable())) {
    console.error("Docker is not available. Please start the Docker daemon.");
    return;
  }

  // Pull the image (with progress callback)
  console.log("Pulling image...");
  await pullImage(minimalConfig.image, (event: { status?: string }) => {
    if (event.status) console.log(`  ${event.status}`);
  });

  // Create and start the runner
  const runner = createRunner(minimalConfig);

  // Start in detached mode
  const result = await runner.start({ detach: true });
  console.log(`Agent started: ${result.containerId} (${result.status})`);

  // Check if running
  console.log("Running:", await runner.isRunning());

  // Stop and clean up
  await runner.stop({ timeout: 10, remove: true });
  console.log("Agent stopped.");
}

// Example: Using low-level Docker utilities directly
async function dockerUtilities(): Promise<void> {
  if (!(await isDockerAvailable())) {
    console.error("Docker is not available.");
    return;
  }

  // List running heretic containers
  const containers = await listContainers(undefined, { all: false });
  const hereticContainers = containers.filter((c) =>
    c.Names?.some((name: string) => name.startsWith("/heretic-"))
  );

  console.log(`Found ${hereticContainers.length} heretic container(s):`);
  for (const c of hereticContainers) {
    console.log(`  - ${c.Names[0]} (${c.Image}) — ${c.State}`);
  }

  // Stop and remove a specific container by ID
  // const id = "abc123...";
  // await stopContainer(id, { t: 10 });
  // await removeContainer(id, { force: true });
}

if (import.meta.main) {
  runDockerAgent().catch(console.error);
}

export { minimalConfig, fullConfig, runDockerAgent, dockerUtilities };
