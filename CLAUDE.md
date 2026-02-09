# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

heretic-cli — a CLI tool built with Bun and TypeScript that compiles to a native executable. Manages project initialization, local dev setup, and self-updates via GitHub releases.

## Commands

All commands run from `cli/` directory:

```bash
bun install              # Install dependencies
bun run dev              # Run CLI in dev mode
bun run dev -- <args>    # Run with arguments (e.g. bun run dev -- init)
bun test                 # Run all tests
bun test tests/cli.test.ts  # Run a single test file
bun test --watch         # Watch mode
bun test --coverage      # Coverage report
bun run lint             # ESLint check
bun run lint:fix         # Auto-fix lint issues
bun run format           # Prettier format
bun run format:check     # Check formatting
bun run build            # Build native executable for current platform
bun run build:all        # Cross-platform builds (linux/macos/windows)
```

## Architecture

The CLI lives entirely in `cli/`. Entry point is `src/index.ts` which checks for pending updates, then delegates to `src/cli.ts` (Commander.js routing).

**Commands** (`src/commands/`): Each command is a separate file exporting an async function. Registered in `cli.ts`. To add a new command: create file in `src/commands/`, export from `src/commands/index.ts`, register in `src/cli.ts`.

**Settings** (`src/utils/settings.ts`, `src/types/settings.ts`): YAML-based config stored at `~/.heretic/settings.yaml`. Supports multiple agent types (Anthropic, ZAI) with typed configs. Deep merge on save.

**Docker** (`src/utils/docker.ts`): Wrapper around dockerode for container/image lifecycle with progress callbacks.

**Self-update** (`src/commands/update.ts`): Two-phase update — downloads new binary, stages as pending file, applies on next startup. Handles platform detection and permission issues.

**Agent Profiles** (`src/utils/profile-loader.ts`): YAML profiles stored in `~/.heretic/agents/`. Each profile defines Docker image, environment variables, volumes, and secrets. Profiles are created/managed via CLI commands only.

**Config Resolution** (`src/utils/config-resolver.ts`): Three-layer merge system: global profile → local override (`.heretic/cli/<profile>.yaml`) → CLI flags. Supports variable interpolation (`${VAR}`) and secrets resolution from shell scripts. Per-profile local overrides allow multiple profiles to have local configs in the same project.

**Image Templates** (`src/templates/`): Pure-function generators for Docker image assets. Used by `heretic-cli image build` and `heretic-cli image generate`. Types are in `types.ts`, Dockerfile generation in `dockerfile.ts` (Handlebars template), entrypoint in `entrypoint.ts`, and resource scripts in `resources.ts`. Static assets (`.hbs`, `.sh`, bash scripts) live in `src/templates/assets/` and are embedded via Bun's `import ... with { type: "text" }` so `bun build --compile` includes them. Type declarations for these imports are in `src/types/text-imports.d.ts`.

## Agent Management

All agent configuration MUST be done via CLI commands:

```bash
heretic-cli init              # Interactive setup: GitHub tokens + agent profiles
heretic-cli agents list       # List configured agents
heretic-cli agents show <n>   # Show agent profile details
heretic-cli agents validate   # Validate all profiles
heretic-cli agents delete <n> # Delete agent, containers, and associated files
heretic-cli run <profile>     # Run an agent
```

The CLI automatically creates (cross-platform):
- Secret scripts — outputs API tokens
  - Unix: `~/.heretic/get-<agent>-key.sh` (bash)
  - Windows: `~/.heretic/get-<agent>-key.cmd` (cmd.exe)
  - PowerShell `.ps1` scripts also supported when manually created
- Claude settings (`~/.heretic/<agent>-settings.json`) - Claude Code permissions + `"model": "opus"` default
- Agent profiles (`~/.heretic/agents/<agent>.yaml`) - full configuration with `provider` field

### Secrets Resolution Modes

The `secrets:` field in profiles supports three value modes (detected automatically):
1. **Script path** (`~/.heretic/get-key.sh`) → executed, stdout returned
2. **Env var reference** (`$MY_TOKEN` or `${MY_TOKEN}`) → resolved from `process.env`
3. **Plain value** (`sk-ant-api03-...`) → used as-is

Never manually edit these files unless debugging. Use CLI commands for all changes.

### Provider and Agent Type Inference

Profiles MUST include a `provider` field (`anthropic`, `thirdparty`, or `copilot`). If missing, the config resolver infers provider from `agent_type`:
- `copilot-cli` → `copilot`
- everything else → `anthropic`

This matters because copilot tokens (`GH_COPILOT_TOKEN`, `GITHUB_COPILOT_TOKEN`) are only injected into containers with `provider: copilot`.

### Anthropic Token Types

When configuring an Anthropic agent with a token, the user selects the type:
- **API Key** → sets `ANTHROPIC_API_KEY` in profile (docker-runner maps to `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_AUTH_KEY`)
- **OAuth/Subscription** → sets `CLAUDE_CODE_OAUTH_TOKEN` + `ANTHROPIC_AUTH_TOKEN: ""` + `ANTHROPIC_BASE_URL: ""` (empty strings prevent Claude Code from falling back to API mode)

### Onboarding Seeding

For non-copilot agents, the docker-runner seeds `.claude.json` with `{ "hasCompletedOnboarding": true }` to skip Claude Code's interactive login screen. This file is bind-mounted to `/home/agent/.claude.json` and `/root/.claude.json`.

## Documentation Requirements

**IMPORTANT:** When adding a new CLI command or updating an existing one, you MUST update the documentation:

1. **`cli/docs/USER_GUIDE.md`** - End-user documentation (commands, options, examples)
2. **`cli/AGENTS.md`** - Agent configuration guide for AI agents working on the codebase

Update these files for:
- New commands and their options
- Changed command behavior or flags
- New configuration fields
- Updated examples
- Cross-platform considerations (Linux, macOS, Windows)

The USER_GUIDE.md is the single source of truth for end users. Always consider all three operating systems when documenting paths, scripts, and platform-specific behavior.

## Build After Changes

**IMPORTANT:** After modifying any CLI source code, always rebuild the native binary:

```bash
cd cli && bun run build
```

The user runs the compiled `heretic-cli` binary, not the dev source. Source changes have no effect until the binary is rebuilt.

## Lint and Format Must Pass

**IMPORTANT:** Every time you modify CLI source or test files, run both from `cli/`:

```bash
bun run format           # Auto-fix formatting (Prettier)
bun run lint             # Check for lint errors (ESLint)
```

Fix **all errors** before committing. CI runs `bun run format:check` and `bun run lint` — both must pass. Common pitfalls:

- **Unused imports** — remove them, don't just prefix with `_`.
- **Unused catch binding** — use bare `catch {` instead of `catch (error) {` when the variable is not referenced.
- **`no-require-imports`** — use `import` instead of `require()`.
- **`no-useless-catch`** — remove `try/catch` blocks that just re-throw (`catch (e) { throw e }`).

Warnings (`no-explicit-any`, `explicit-function-return-type`) do not block CI but should be minimized.

## Code Conventions

- **Always use Pino logger** (`import { getLogger } from "../logger"`), never `console.log`/`console.error`. Use `logRaw()` for unformatted CLI output.
- ESM imports (`import`/`export`), `async/await` over raw promises.
- ESLint enforces explicit function return types (warn) and no explicit `any` (warn). Unused vars prefixed with `_`.
- Prettier: 2-space indent, double quotes, semicolons, trailing commas.
- Tests use `bun:test` with `spyOn` for mocking and `mock` for fetch.
- Documentation goes in `cli/docs/`.
