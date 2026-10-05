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
heretic-cli --verbose init
heretic-cli -V run <name>
```

### File Logging

Users can write logs to a file with `--log-file <path>`. File logs are always in JSON format and include all log levels.

### Image Templates

`src/templates/` — pure-function generators for Docker image build assets:

| File | Purpose |
|------|---------|
| `types.ts` | `ImageAgentType`, `ImageBuildConfig`, `VALID_IMAGE_AGENTS`, `DEFAULT_BASE_IMAGE` |
| `dockerfile.ts` | `generateDockerfile()` — compiles Handlebars template with pre-computed context |
| `entrypoint.ts` | `generateEntrypoint()` — returns embedded entrypoint.sh |
| `resources.ts` | `SIDECAR_EXEC_SCRIPT`, `SSH_EXEC_SCRIPT` — embedded resource scripts |
| `sidecar-images.ts` | `generateSidecarDockerfile()` + embedded `EXEC_SERVER_MAIN_GO`/`EXEC_SERVER_GO_MOD` — the **server-side** builder images |
| `index.ts` | Barrel export |

Static assets live in `src/templates/assets/`:

| File | Purpose |
|------|---------|
| `Dockerfile.hbs` | Handlebars template for Dockerfile generation |
| `entrypoint.sh` | Universal container entrypoint script (baked as the image `ENTRYPOINT`; resolves tool backends → `exec "$@"`) |
| `sidecar-exec` | HTTP build-sidecar **client** — routes a wrapped command to `POST /exec` on the sidecar for its runtime. Encodes argv with incremental `jq --arg` (NOT `$ARGS.positional --args`, which breaks on jq 1.6 — Debian bookworm — for any dash-flag) |
| `ssh-exec` | SSH backend for tool command routing |

The **server** side is vendored under `build-sidecars/` (outside `src/`, so lint/format skip it):

| Path | Purpose |
|------|---------|
| `build-sidecars/exec-server/main.go` | Go `exec-server`: `/health`, `/info`, `/exec` (blocking), `/exec/stream` (SSE). Embedded as text; compiled inside each builder's Docker build stage |
| `build-sidecars/exec-server/go.mod` | Stdlib-only module (no deps) |

Assets are embedded via Bun's `import ... with { type: "text" }` so `bun build --compile` includes them in the binary. The Dockerfile uses Handlebars (`{{variable}}`, `{{#if}}`) which avoids conflicts with Docker's `${VAR}` syntax. Type declarations for `.hbs`, `.sh`, `.go`, and `.mod` imports are in `src/types/text-imports.d.ts`.

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
heretic-cli init                    # Interactive setup wizard
heretic-cli agents list             # List all configured agents
heretic-cli agents show <name>      # Show profile details
heretic-cli agents validate         # Validate all profiles
heretic-cli agents delete <name>           # Delete agent, containers, and files
heretic-cli agents delete <name> -f        # Delete without confirmation
heretic-cli agents mcp <name>              # Paste MCP JSON into global profile
heretic-cli agents mcp <name> --file f.json  # Read MCP JSON from file
heretic-cli agents mcp <name> --local      # Apply to local override
heretic-cli run <name>              # Run in interactive mode
heretic-cli run <name> -d           # Run in detached mode
heretic-cli run <name> -s feat-x   # Run in a named session
heretic-cli run <name> --sidecar node --sidecar python   # Attach build sidecars (repeatable)
heretic-cli run <name> --builder-image node=my-builder:latest  # Override a builder image
heretic-cli run <name> --disable-sidecars   # Turn off all sidecars for this run
heretic-cli <name>                  # Shorthand for run
heretic-cli stop <name>             # Stop specific agent (with confirmation)
heretic-cli stop <name> --force     # Stop without confirmation
heretic-cli stop --all              # Stop all heretic containers
heretic-cli stop -s feat-x         # Stop containers in a specific session
heretic-cli image build --agent claude           # Build a Claude agent image
heretic-cli image build --agent all --with-all   # Build all agents with all tools
heretic-cli image build --agent claude --dry-run # Preview Dockerfile without building
heretic-cli image build-sidecar node             # Build heretic-builder-node:latest
heretic-cli image build-sidecar python --runtime-version 3.12 --push -r ghcr.io/acme
heretic-cli image build-sidecar go --dry-run     # Preview the builder Dockerfile
heretic-cli image generate --format dockerfile   # Output Dockerfile to stdout
heretic-cli image generate --format entrypoint   # Output entrypoint.sh to stdout
heretic-cli image generate --format sidecar-dockerfile --runtime rust  # Builder Dockerfile
heretic-cli image generate --format exec-server  # Output the Go exec-server source
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

### Docker-in-Docker (`dind: true`)

Both runners bind `getDockerSocketMountSource()` to `/var/run/docker.sock` and log it at start. The bind source is resolved by the daemon, not the CLI: on macOS/Windows the daemon lives in a VM (Docker Desktop, Colima, OrbStack) whose socket is `/var/run/docker.sock`, so that is the source there — never the client socket `~/.docker/run/docker.sock` (`getDockerSocketPath()`, used only for the CLI's own dockerode connection). On Linux a `DOCKER_HOST=unix://…` (rootless) socket is used when set.

### Published Ports

`src/utils/ports.ts` owns port publishing. Profile fields in `extra`: `ports` (docker `-p` specs — single ports, ranges `3000-3020`, remaps `13000-13020:3000-3020`, bind IPs `127.0.0.1:8080:8080` / `[::1]:80:80`, `/udp`), `port_presets` (`PORT_PRESETS` + groups `dev`, `all`), `ports_host_ip`, `ports_offset`. `resolveConfig()` expands them after interpolation (`buildPortMappings`) into `ResolvedAgentConfig.portMappings` and rewrites `extra.ports` as compact specs, so both runners only read `extra.ports` (docker-runner via `toDockerPortConfig`, which also fills `ExposedPorts` — the Engine API ignores bindings for ports the image doesn't EXPOSE; compose-runner passes the specs through). One binding per container port: explicit specs win over presets, later over earlier. `run-agent.ts` drops preset ports that are busy on the host (`dropBusyOptionalPorts`) before the runner starts. CLI: `-p/--port`, `--port-preset` (both append via `ResolveOptions.addPorts` / `addPortPresets`), `--port-host-ip`, `--port-offset`, `--no-ports`; `heretic-cli port-presets` lists presets. User docs: `docs/USER_GUIDE.md` → Publishing Ports.

### MCP Mounting

A profile's `mcp:` servers are written to `.heretic/temp/<session>/.mcp.json` and bind-mounted
into the container (`/workspace/.mcp.json` for Claude, `~/.copilot/mcp-config.json` for Copilot
CLI).

The mount is **skipped** when the project directory already has its own usable MCP config, so a
project's `.mcp.json` wins over the profile. Set `mcp_override: true` on the profile to always
mount the profile's servers instead.

"Usable" is decided by `hasUsableMcpConfig()` in `src/runners/mcp-helper.ts`: a file that is
missing, 0-byte, whitespace-only, invalid JSON, or that declares no servers counts as **absent**,
so the profile's MCP still mounts. Existence alone is not enough — a stray empty `.mcp.json` in the
project root would otherwise silently leave the agent with no MCP servers at all.

Note that the project directory is the directory you launch from, not the repo you intend to work
on. Running an agent from a parent directory makes that parent the project root, and its
`.mcp.json` (or absence of one) is what governs.

Servers may use either transport:

```yaml
mcp:
  - name: context7          # stdio (default): requires command
    type: stdio
    command: npx
    args: ["-y", "@upstash/context7-mcp"]
  - name: watchword         # http: requires url, optional headers
    type: http
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer <token>"
```

Inline YAML entries must set `type: http` explicitly — unlike the `mcp_file` JSON path, the
resolved-config validator does not infer http from the presence of `url`, and an entry with `url`
but no `type` fails with `mcp[N].command must be non-empty`.

### Tool Execution Backends (build sidecars)

A profile can offload build/tool commands (`npm`, `pip`, `mvn`, `go`, `cargo`, …) from the agent
container to sibling **build-sidecar** containers that share the workspace. The agent's baked
entrypoint (`setup_tool_wrappers`) writes `/opt/sidecar/wrappers/<cmd>` that route to
`sidecar-exec <runtime>`, which POSTs to the sidecar's HTTP `exec-server`. **A local binary always
wins** — a wrapper is generated only for a command the agent image does not already provide.

```yaml
runner: docker                  # docker (native) or compose — both orchestrate sidecars
volumes:
  - source: ${CWD}
    target: /workspace          # the shared bind (must match workspace_target)
workdir: /workspace
tool_backends:
  workspace_target: /workspace  # default "/workspace"; must match a volume target
  ready_timeout: 60             # seconds to wait for each sidecar to be healthy
  run_as_caller_uid: true       # default true — build artefacts are caller-owned (gap F-2)
  sidecars:
    - runtime: node             # one of node|python|java|go|rust (validated)
      image: heretic-builder-node:latest
      port: 8080                # default 8080
      env: { NX_DAEMON: "false" }
      env_passthrough: [NPM_TOKEN]        # allowlist forwarded per-exec (gap C-8)
      cache_volumes: ["heretic-cache-node:/home/agent/.npm"]  # warm caches (gap F-3)
    - runtime: python
      image: heretic-builder-python:latest
```

**Two orchestrators, identical semantics.** Both emit one `builder-<runtime>` per sidecar bound to
the **same host path** as the agent at `workspace_target` (so both see one filesystem), inject
`BUILD_SIDECARS={"node":{"internal_url":"http://builder-node:8080"},…}` (normative shape; only
`internal_url` is read) + the unioned `SIDECAR_ENV_PASSTHROUGH`, health-gate the agent on each
builder, and run builders as the caller uid with `cap_drop: [ALL]` + `no-new-privileges` and **no
published ports** (reachable only by the `builder-<runtime>` name on a private network):

- **`ComposeRunner.buildSidecarOrchestration`** — builder *services* in a generated
  `docker-compose.yaml`, health-gated via `depends_on: { condition: service_healthy }`.
- **`SidecarManager`** (`runners/sidecar-manager.ts`, used by `DockerRunner`) — dockerode-native:
  creates a per-run user-defined network (`heretic-net-<agent>-<session>-<hash>`), starts each
  builder with a `builder-<runtime>` network alias, polls health (container HEALTHCHECK, or an
  `exec-server -healthcheck` exec probe for images without one) before starting the agent, and tears
  builders + network down on `stop()`. Everything is labeled `heretic.role=build-sidecar` /
  `heretic.role=build-network` so `heretic-cli stop` cleans up siblings + network even for a
  detached run, and `heretic-cli ps` hides sidecars from the agent listing. Named `cache_volumes`
  are preserved across runs (warm caches, gap F-3).

**Validation** (`validateResolvedConfig`): rejects unknown runtimes (gap B-3), empty images,
duplicate runtimes, out-of-range ports, and a missing workspace volume; **warns** when both a
sidecar and the `ssh:` backend are configured (a build would span two filesystems, gap B-5). The
`custom` runner can't manage sidecars and is rejected; `docker` and `compose` both work.

**Routing caveat (gap B-2):** only the ~25 commands in `setup_tool_wrappers`' `RUNTIME_COMMANDS`
map route to a sidecar. `make`, `tsc`, `jest`, `./node_modules/.bin/*`, `uv`, and `bun` are **not**
wrapped and run locally in the agent container.

**Producing the builder images:** `heretic-cli image build-sidecar <runtime>` builds
`heretic-builder-<runtime>:latest` — a multi-stage image that compiles the vendored Go
`exec-server` (`build-sidecars/exec-server/`) and drops it onto the runtime toolchain base as a
non-root user with a port-agnostic healthcheck. `--runtime-version`, `--registry`/`--push`,
`--arch`, `--port`, and `--dry-run` mirror `image build`. Any image running a compatible
`exec-server` (the four-endpoint contract) can be used instead — the *bring-your-own-builder*
on-ramp. Inspect artefacts with `image generate --format sidecar-dockerfile --runtime <rt>` and
`--format exec-server`.

The SSH backend (top-level `ssh:` block) is the sibling backend and resolves into the same wrapper
mechanism via `ssh-exec`; prefer one backend per project.

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

1. **Global** (`~/.heretic/<agent>-settings.json`) - Created by `heretic-cli init`
2. **Local** (`.heretic/cli/claude-settings.json`) - Created by `heretic-cli local-init`

At runtime, local settings are **auto-detected and merged** with global:

| Field Type | Merge Strategy |
|------------|----------------|
| Arrays (`permissions.allow/deny`) | Union (combined, deduplicated) |
| Objects (`env`) | Shallow merge (local wins) |
| Primitives | Local replaces global |

### Provider-Aware Templates

`heretic-cli local-init` generates provider-aware templates:

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

### Running as Root

Set `extra.run_as_root: true` in a profile — or pass `--root` to `heretic-cli run <agent>` (also works on the `heretic-cli <agent>` shortcut) — to keep the container running as **root** instead of the image's `agent` user. The `--root` flag is a CLI override that sets `extra.run_as_root` for that run only; it is only applied when explicitly passed, so it never clobbers a profile's value when absent. The runners (`docker-runner.ts`, `compose-runner.ts`) force `User: root` and inject `HERETIC_RUN_AS_ROOT=1`. The entrypoint's root-mode block (top of `entrypoint.sh`) then exports `HOME=/home/agent` and `USER=root` before anything else runs. Keeping `HOME=/home/agent` means all bind-mounted config (claude settings, `.claude.json`, auth, ssh keys) still resolves under `$HOME`.

**No image rebuild required.** The root branch lives in `entrypoint.sh`, which is baked into the image as its `ENTRYPOINT` (`/entrypoint.sh`) — but when `run_as_root` is set, the runners write the current binary-embedded entrypoint to the session dir and bind-mount it over `/entrypoint.sh` (read-only), so the flag works on images built before the feature existed. The `--root` flag is parsed regardless of position on the command line (`run cs --root` and `run --root cs` both work); `src/index.ts` `hoistRootFlag()` moves a bare `--root` ahead of the agent name so `passThroughOptions()` doesn't swallow it, while leaving anything after a `--` separator (the custom command) untouched.

Note: `docker exec` into a root container reports `HOME=/root` because it's a fresh login shell that doesn't inherit the entrypoint's exported env. The real session process (PID 1) has `HOME=/home/agent` — verify with `tr '\0' '\n' < /proc/1/environ | grep HOME`.

### Container Labels

Every heretic-managed container gets these labels:

| Label | Value | Description |
|-------|-------|-------------|
| `heretic.managed` | `"true"` | Identifies heretic containers |
| `heretic.agent` | Profile name | Agent profile used to create the container |
| `heretic.project` | Absolute path | Project directory the container was started from |
| `heretic.session` | Session name | Session name (default: `"default"`) |

**Sessions and naming.** The agent container is `heretic-<profile>-<session>-<hash8>`
(`getAgentContainerName()` in `src/utils/session.ts`, shared by the docker and compose runners;
`<hash8>` = first 8 hex chars of SHA-256 of the project dir). The compose runner's project name is
`heretic-<profile>-<session>-<hash8>` too. Before starting, `run` (`ensureSessionFree()` in
`src/commands/run-agent.ts`) looks the name up and **refuses with exit 1** if that container is
running, paused or restarting — the runners' `removeExistingContainer()` would otherwise kill the
live agent. A stopped container is still removed and recreated. To run the same profile twice in
one folder, use different `-s` sessions. Skipped for the `custom` runner.

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

`heretic-cli init` creates `.sh` on Unix and `.cmd` on Windows. Users can replace these with `.ps1` scripts or secret manager integrations (1Password, Keychain, pass).

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

## Lint and Format Must Pass

**IMPORTANT:** Every time you modify CLI source or test files, run both from `cli/`:

```bash
bun run format           # Auto-fix formatting (Prettier)
bun run lint             # Check for lint errors (ESLint)
```

Fix **all errors** before committing. CI runs `bun run format:check` and `bun run lint` — both must pass.

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
3. **Test with `heretic-cli init`** - Ensure the wizard creates valid configurations
4. **Validate profiles** - Run `heretic-cli agents validate` after changes

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
