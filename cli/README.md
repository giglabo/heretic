# heretic-cli

VibeCoder Heretic CLI — manages AI agent profiles, Docker containers, project initialization, and self-updates. Built with [Bun](https://bun.sh/) and TypeScript, compiles to a native executable.

## Requirements

- [Bun](https://bun.sh/) >= 1.2.0
- [Docker](https://www.docker.com/) (for running agents)

## Installation

```bash
cd cli
bun install
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `heretic init` | Interactive setup: GitHub tokens + agent profiles |
| `heretic run <profile>` | Run an agent by profile name |
| `heretic ps` | List running agent containers |
| `heretic stop [name]` | Stop agent container(s) |
| `heretic attach <name>` | Attach to a running agent container |
| `heretic agents list` | List configured agent profiles |
| `heretic agents show <name>` | Show agent profile details |
| `heretic agents edit <name>` | Edit an agent profile |
| `heretic agents validate` | Validate all profiles |
| `heretic agents delete <name>` | Delete agent and associated files |
| `heretic local-init [profile]` | Initialize per-profile local override |
| `heretic local-validate [profile]` | Validate local config(s) |
| `heretic doctor` | Run environment health checks |
| `heretic update` | Check for and install updates |

Unknown commands are treated as agent profile names, so `heretic claude` is equivalent to `heretic run claude`.

For full usage details, options, and examples see [docs/USER_GUIDE.md](../local-docs/cli/CLI_USER_GUIDE.md).

## Development

```bash
bun run dev              # Run CLI in dev mode
bun run dev -- init      # Run with arguments
bun test                 # Run all tests
bun run lint             # ESLint check
bun run format           # Prettier format
```

## Building

```bash
bun run build            # Build for current platform → dist/heretic-cli
bun run build:all        # Cross-platform builds (linux/macos/windows)
```

Platform-specific: `bun run build:linux-x64`, `build:linux-arm64`, `build:macos-x64`, `build:macos-arm64`, `build:windows`.

## Project Structure

```
cli/
├── src/
│   ├── index.ts              # Entry point (pending update check)
│   ├── cli.ts                # Commander.js routing
│   ├── logger.ts             # Pino logger
│   ├── commands/             # CLI commands
│   │   ├── init.ts           # Interactive setup
│   │   ├── run-agent.ts      # Run agent container
│   │   ├── agents.ts         # Agent CRUD subcommands
│   │   ├── ps.ts             # List containers
│   │   ├── stop.ts           # Stop containers
│   │   ├── attach.ts         # Attach to container
│   │   ├── localInit.ts      # Local override scaffolding
│   │   ├── local-validate.ts # Local config validation
│   │   ├── doctor.ts         # Environment health checks
│   │   └── update.ts         # Self-update
│   ├── runners/              # Container execution backends
│   │   ├── docker-runner.ts  # Single-container (dockerode)
│   │   ├── compose-runner.ts # Multi-service (docker compose)
│   │   ├── custom-runner.ts  # Custom command runner
│   │   └── mcp-helper.ts     # MCP server config injection
│   ├── types/                # TypeScript types
│   │   ├── agent-profile.ts  # Agent/profile schemas
│   │   └── settings.ts       # Global settings schema
│   └── utils/                # Shared utilities
│       ├── config-resolver.ts # Three-layer config merge
│       ├── profile-loader.ts  # YAML profile I/O
│       ├── interpolation.ts   # Secret/env var resolution
│       ├── docker.ts          # Docker client wrapper
│       ├── settings.ts        # Settings I/O
│       └── session.ts         # Session management
├── tests/                     # bun:test test suite
├── docs/
│   └── USER_GUIDE.md          # End-user documentation
├── examples/                  # Usage examples
└── dist/                      # Build output (gitignored)
```