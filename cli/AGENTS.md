# AGENTS.md - AI Agent Instructions for heretic-cli

This document provides context and guidelines for AI agents working on this codebase.

## Project Overview

**heretic-cli** is a command-line tool built with Bun that compiles to a native executable. The project uses TypeScript with strict type checking and Pino for structured logging.

## Tech Stack

- **Runtime**: Bun (https://bun.sh/)
- **Language**: TypeScript (ESNext, strict mode)
- **Logger**: Pino with pino-pretty for console output
- **Testing**: Bun's built-in test runner (`bun:test`)
- **Linting**: ESLint 9 with flat config + typescript-eslint
- **Formatting**: Prettier
- **Build**: Bun's native `--compile` flag for standalone executables

## Key Commands

```bash
bun install          # Install dependencies
bun run dev          # Run CLI in dev mode
bun run build        # Build native executable
bun test             # Run tests
bun run lint         # Run linter
bun run lint:fix     # Fix lint issues
bun run format       # Format code
```

## Architecture

### Entry Point

`src/index.ts` checks for pending updates, then delegates to `src/cli.ts` (Commander.js routing).

### Logger

`src/logger.ts` - Pino logger configuration with support for:
- Verbose mode (`--verbose` flag) - enables debug level logging
- File output (`--log-file <path>` flag) - writes logs to a file
- Pretty console output with colors
- Structured JSON logs in file

**IMPORTANT**: Always use the logger from `src/logger.ts`, never `console.log`/`console.error`:

```typescript
import { getLogger, logRaw } from "../logger";

const logger = getLogger();

logger.info("User-facing information");
logger.warn("Warning about something");
logger.error("Error occurred");
logger.debug("Debug details (only with --verbose)");

// Use logRaw for unformatted CLI output (help text, etc.)
logRaw("Help text without formatting");
```

### Log Levels

| Level | Usage |
|-------|-------|
| `logger.info()` | User-facing messages, progress updates |
| `logger.warn()` | Warnings, non-critical issues |
| `logger.error()` | Errors, failures |
| `logger.debug()` | Debug information (only shown with `--verbose`) |

### Verbose Mode

Users can enable verbose logging with `--verbose` or `-V`:

```bash
heretic --verbose init
heretic -V run <name>
```

### File Logging

Users can write logs to a file with `--log-file <path>`. File logs are always in JSON format and include all log levels.

### Commands

All commands are in `src/commands/`. Each command is a separate file exporting an async function, registered in `cli.ts`.

### Adding a New Command

1. Create `src/commands/newCommand.ts`:
   ```typescript
   import { getLogger } from "../logger";

   export async function runNewCommand(args: string[]): Promise<void> {
     const logger = getLogger();
     logger.info("Running new command...");
     logger.debug("Detailed debug information");
     // Implementation
   }
   ```

2. Export from `src/commands/index.ts`

3. Register in `src/cli.ts`

4. Add tests in `tests/`

5. **Update `cli/docs/USER_GUIDE.md`** and `cli/docs/AGENTS.md`

## Agent Configuration

### CLI-First Principle

**All agent configuration MUST be done through CLI commands.** Never manually create or edit configuration files.

The CLI automatically manages (cross-platform):
- `~/.heretic/agents/<name>.yaml` - Agent profiles (always include `provider` field)
- `~/.heretic/get-<name>-key.sh` (Unix) / `.cmd` (Windows) - Secret scripts (API tokens)
- `~/.heretic/<name>-settings.json` - Claude Code settings (default includes `"model": "opus"`)
- `.heretic/temp/` - Runtime temporary files (session dirs, onboarding seeds)

### Agent Commands

```bash
heretic init                    # Interactive setup wizard
heretic agents list             # List all configured agents
heretic agents show <name>      # Show profile details
heretic agents validate         # Validate all profiles
heretic agents delete <name>           # Delete agent, containers, and files
heretic agents delete <name> -f        # Delete without confirmation
heretic agents mcp <name>              # Paste MCP JSON into global profile
heretic agents mcp <name> --file f.json  # Read MCP JSON from file
heretic agents mcp <name> --local      # Apply to local override
heretic run <name>              # Run in interactive mode
heretic run <name> -d           # Run in detached mode
heretic run <name> -s feat-x   # Run in a named session
heretic <name>                  # Shorthand for run
heretic stop <name>             # Stop specific agent (with confirmation)
heretic stop <name> --force     # Stop without confirmation
heretic stop --all              # Stop all heretic containers
heretic stop -s feat-x         # Stop containers in a specific session
```

### Profile Structure

Agent profiles (`~/.heretic/agents/*.yaml`) contain:

```yaml
image: docker-image-name
runner: docker                  # docker | compose | custom
agent_type: claude              # claude | aider | copilot-cli | generic
provider: anthropic             # anthropic | zai | copilot
interactive: true
tty: true

volumes:
  - source: ${CWD}
    target: /workspace

workdir: /workspace

secrets:
  API_KEY_VAR: ~/.heretic/get-key.sh

env:
  ANTHROPIC_BASE_URL: https://api.example.com
  ANTHROPIC_API_KEY: ${API_KEY_VAR}

claude_settings: ~/.heretic/agent-settings.json

mcp_file: ~/shared/mcp-servers.json  # Optional: load MCP servers from JSON file
```

### Provider Types

| Provider | Env Vars Set | Description |
|----------|-------------|-------------|
| `anthropic` (default) | Depends on token type (see below) | Direct Anthropic API |
| `thirdparty` | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | Proxy API (ZAI, Kimi, custom) |
| `copilot` | `<NAME>_TOKEN`, `GH_COPILOT_TOKEN`, `GITHUB_COPILOT_TOKEN` | Custom API, no Anthropic env vars |

#### Anthropic Token Types

When configuring an Anthropic agent with a token, the type determines which env vars are set:

| Token Type | Profile env | Container env (after runner transform) |
|------------|------------|----------------------------------------|
| **API Key** | `ANTHROPIC_API_KEY: ${SECRET}` | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_AUTH_KEY` |
| **OAuth/Subscription** | `CLAUDE_CODE_OAUTH_TOKEN: ${SECRET}`, `ANTHROPIC_AUTH_TOKEN: ""`, `ANTHROPIC_BASE_URL: ""` | Same (empty strings preserved to prevent API fallback) |

#### Provider Inference

If a profile is missing the `provider` field, the config resolver infers it from `agent_type`:
- `copilot-cli` → `copilot`
- all others → `anthropic`

This is critical because **copilot tokens** (`GH_COPILOT_TOKEN`, `GITHUB_COPILOT_TOKEN`) are **only injected into containers with `provider: copilot`**. All other containers receive only `GH_TOKEN` and `GITHUB_TOKEN`.

#### Empty Env Var Handling

The runners filter out env vars with empty string values to avoid overriding container defaults. **Intentionally empty values** set in `config.env` (e.g., `ANTHROPIC_AUTH_TOKEN: ""` for OAuth mode) are preserved. Only accidentally empty values (e.g., failed interpolation) are removed.

### Claude Settings Merge

Claude Code settings use a two-layer system:

1. **Global** (`~/.heretic/<agent>-settings.json`) - Created by `heretic init`
2. **Local** (`.heretic/cli/claude-settings.json`) - Created by `heretic local-init`

At runtime, local settings are **auto-detected and merged** with global:

| Field Type | Merge Strategy |
|------------|----------------|
| Arrays (`permissions.allow/deny`) | Union (combined, deduplicated) |
| Objects (`env`) | Shallow merge (local wins) |
| Primitives | Local replaces global |

### Provider-Aware Templates

`local-init` generates provider-aware templates:

**ZAI** - Includes model override examples:
```json
{
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "custom-model"
  }
}
```

**Anthropic / Copilot** - Permissions only:
```json
{
  "permissions": {
    "allow": ["mcp__custom"]
  }
}
```

### GitHub Token Injection

All agent containers receive GitHub tokens from `~/.heretic/settings.yaml`. **Copilot tokens are only injected for `provider: copilot` agents.**

| Container Env Var | Settings Source | Fallback | Provider |
|-------------------|----------------|----------|----------|
| `GH_TOKEN` | `github.token` | — | All |
| `GITHUB_TOKEN` | `github.token` | — | All |
| `GH_COPILOT_TOKEN` | `github.copilot_token` | `github.token` | `copilot` only |
| `GITHUB_COPILOT_TOKEN` | `github.copilot_token` | `github.token` | `copilot` only |

Per-agent `git.token` in profiles overrides `GH_TOKEN` and `GITHUB_TOKEN` for that agent.

This applies to all runner types: `docker`, `compose`, and `custom`.

### Onboarding Seeding

For non-copilot agents (claude, aider, generic), the docker-runner automatically creates `.claude.json` with `{ "hasCompletedOnboarding": true }` in the session directory. This file is bind-mounted to `/home/agent/.claude.json` and `/root/.claude.json` to skip Claude Code's interactive login/onboarding screen.

### Container Labels

Every heretic-managed container gets these labels:

| Label | Value | Description |
|-------|-------|-------------|
| `heretic.managed` | `"true"` | Identifies heretic containers |
| `heretic.agent` | Profile name | Agent profile used to create the container |
| `heretic.project` | Absolute path | Project directory the container was started from |
| `heretic.session` | Session name | Session name (default: `"default"`) |

### File Locations

| File | Purpose |
|------|---------|
| `~/.heretic/settings.yaml` | Global settings (GitHub tokens) |
| `~/.heretic/agents/*.yaml` | Agent profiles (must include `provider` field) |
| `~/.heretic/get-*-key.sh` | Secret scripts (Unix) |
| `~/.heretic/get-*-key.cmd` | Secret scripts (Windows) |
| `~/.heretic/*-settings.json` | Global Claude Code settings (default includes `"model": "opus"`) |
| `.heretic/cli/<profile>.yaml` | Per-profile local overrides |
| `.heretic/cli/claude-settings.json` | Local Claude settings (auto-merged) |
| `.heretic/temp/<session>/` | Session-scoped runtime temp files |
| `.heretic/temp/<session>/.mcp.json` | Generated MCP config |
| `.heretic/temp/<session>/.claude.json` | Onboarding seed (`hasCompletedOnboarding: true`) |
| `.heretic/temp/<session>/settings.json` | Merged Claude settings |
| `.heretic/temp/<session>/compose.yaml` | Generated compose file (compose runner) |

### Secrets Resolution

The `resolveSecrets()` function in `src/utils/interpolation.ts` supports three value modes:

| Mode | Example | Behavior |
|------|---------|----------|
| **Script path** | `~/.heretic/get-key.sh` | Executes the script, uses stdout |
| **Env var reference** | `$MY_TOKEN` or `${MY_TOKEN}` | Resolves from `process.env` |
| **Plain value** | `sk-ant-api03-abc123` | Used as-is |

Detection order: env var ref (`$VAR`/`${VAR}` whole string) → script path (by extension) → plain value.

Secrets are resolved **before** `${VAR}` interpolation in the config resolver (step 5), so resolved secrets become available for `${VAR}` references in `env:` and other profile fields.

#### Cross-Platform Script Execution

| Extension | Unix Shell | Windows Shell |
|-----------|-----------|---------------|
| `.sh` | Default shell (sh/bash) | `bash` (Git Bash / WSL) |
| `.cmd` / `.bat` | N/A | `cmd.exe` (default) |
| `.ps1` | N/A | `powershell -ExecutionPolicy Bypass -File` |

`heretic init` creates `.sh` on Unix and `.cmd` on Windows. Users can replace these with `.ps1` scripts or secret manager integrations (1Password, Keychain, pass).

## Testing Guidelines

- Tests use Bun's native test runner (`bun:test`)
- Use `spyOn` for mocking console output and process.exit
- Use `mock` for mocking fetch calls
- Test files go in `tests/` with `.test.ts` suffix
- Run `bun test` before committing

### Test Patterns

```typescript
import { describe, it, expect, spyOn, mock } from "bun:test";

// Mock fetch
globalThis.fetch = mock(() => Promise.resolve({ ok: true, json: () => ({}) }));

// Mock process.exit
const exitSpy = spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});
```

## Code Style

- Use ESM imports (`import`/`export`)
- Prefer `async/await` over promises
- Use explicit return types on functions (enforced by ESLint)
- Prefix unused parameters with `_` (e.g., `_args`)
- Prettier: 2-space indent, double quotes, semicolons, trailing commas

## Lint Must Pass

**IMPORTANT:** Every time you modify CLI source or test files, run `bun run lint` from `cli/` and fix **all errors** before committing. CI treats lint errors as build failures.

Common lint errors to avoid:

| Rule | Fix |
|------|-----|
| `no-unused-vars` | Remove unused imports/variables. Use bare `catch {` instead of `catch (error) {` when the error variable is not used. |
| `no-require-imports` | Use `import { foo } from "module"` instead of `require("module")`. |
| `no-useless-catch` | Remove `try/catch` blocks that only re-throw: `catch (e) { throw e }`. |

Warnings (`no-explicit-any`, `explicit-function-return-type`) do not block CI but should be minimized in new code.

## Build Notes

**IMPORTANT:** After modifying any CLI source code, always rebuild the native binary:

```bash
bun run build
```

The user runs the compiled `heretic-cli` binary, not the dev source. Source changes have no effect until the binary is rebuilt.

- Native builds include Bun runtime (~55MB baseline)
- Cross-compilation targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`
- Output goes to `dist/` (gitignored)

## Development Guidelines

When modifying agent-related code:

1. **Update `cli/docs/USER_GUIDE.md`** - Document any new commands, options, or behavior changes
2. **Update `cli/docs/AGENTS.md`** - Keep agent configuration examples current
3. **Test with `heretic init`** - Ensure the wizard creates valid configurations
4. **Validate profiles** - Run `heretic agents validate` after changes

## Important Files

| File | Purpose |
|------|---------|
| `package.json` | Scripts, dependencies, version |
| `tsconfig.json` | TypeScript compiler options |
| `eslint.config.js` | Linting rules (flat config) |
| `.prettierrc` | Code formatting rules |
| `src/commands/update.ts` | Contains `GITHUB_REPO` constant to configure |

## Common Issues

### "Cannot find module 'bun:test'"
Install Bun types: `bun add -d @types/bun`

### ESLint not recognizing TypeScript
Ensure `typescript-eslint` is installed and `eslint.config.js` uses flat config format.

### Build fails on import
Ensure all imports use `.ts` extension or configure `moduleResolution: "bundler"` in tsconfig.
