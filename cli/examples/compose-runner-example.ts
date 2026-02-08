/**
 * Compose Runner Example
 *
 * Demonstrates using the ComposeRunner to run an agent alongside
 * additional services (database, cache) via docker-compose.
 *
 * The ComposeRunner generates a temporary docker-compose.yaml and
 * manages the full lifecycle through the docker compose CLI.
 */

import { ComposeRunner } from "../src/runners/compose-runner";
import { createRunner } from "../src/runners";
import type { Runner } from "../src/runners/types";
import type { ResolvedAgentConfig } from "../src/types/agent-profile";

// Example: Full-stack development agent with Postgres and Redis sidecars
const fullStackConfig: ResolvedAgentConfig = {
  name: "fullstack-dev",
  image: "giglabo/claude-heretic:latest",
  runner: "compose",
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
    DATABASE_URL: "postgres://dev:dev@db:5432/app",
    REDIS_URL: "redis://redis:6379",
  },

  workdir: "/workspace",
  command: [],
  tty: true,
  interactive: true,
  mcpOverride: false,
  dind: false,
  extra: {
    network: "bridge",
    labels: {
      team: "platform",
      env: "dev",
    },
  },

  // Compose-specific: additional services alongside the agent container
  compose: {
    services: {
      db: {
        image: "postgres:16",
        environment: {
          POSTGRES_USER: "dev",
          POSTGRES_PASSWORD: "dev",
          POSTGRES_DB: "app",
        },
        ports: ["5432:5432"],
        volumes: ["postgres-data:/var/lib/postgresql/data"],
      },
      redis: {
        image: "redis:7-alpine",
        ports: ["6379:6379"],
      },
    },
    networks: {
      backend: {
        driver: "bridge",
      },
    },
  },

  // MCP servers injected into the agent container
  mcp: [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@anthropic/mcp-server-filesystem", "/workspace"],
    },
  ],

  // Git config for commits inside the container
  git: {
    author_name: "Dev Agent",
    author_email: "agent@example.com",
  },

  // Secrets are already resolved at this point (ResolvedAgentConfig)
  secrets: {
    ANTHROPIC_API_KEY: "sk-ant-xxxxx",
  },
};

// Example: Using the ComposeRunner directly
async function directUsage(): Promise<void> {
  const runner = new ComposeRunner(fullStackConfig);

  console.log("Container ID (before start):", runner.getContainerId()); // undefined

  // Start in detached mode — returns immediately
  const result = await runner.start({ detach: true });
  console.log("Started:", result.containerId, "Status:", result.status);

  // Check if running
  const running = await runner.isRunning();
  console.log("Running:", running);

  // Attach interactively (blocks until container exits or Ctrl+P,Q)
  // await runner.attach();

  // Stop and remove
  await runner.stop({ timeout: 10, remove: true });
}

// Example: Using the factory function (recommended)
async function factoryUsage(): Promise<void> {
  // createRunner() inspects config.runner and returns the right implementation
  const runner: Runner = createRunner(fullStackConfig);

  const result = await runner.start({ detach: true });
  console.log("Started via factory:", result.containerId);

  await runner.stop({ remove: true });
}

if (import.meta.main) {
  directUsage().catch(console.error);
}

export { fullStackConfig, directUsage, factoryUsage };
