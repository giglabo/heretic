# Heretic CLI User Guide

## Overview

Heretic CLI manages containerized AI coding agents. It uses a layered configuration system where global agent profiles are defined once, then extended per-project with local overrides.

## Important: CLI-First Approach

**All agent configuration must be done through CLI commands.** The CLI automatically creates and manages:

- **Secret scripts** — Shell scripts that output API tokens
  - Unix: `~/.heretic/get-<agent>-key.sh`
  - Windows: `~/.heretic/get-<agent>-key.cmd`
  - PowerShell `.ps1` scripts also supported when manually created
- **Claude settings** (`~/.heretic/<agent>-settings.json`) - Claude Code permissions config (default includes `"model": "opus"`)
- **Agent profiles** (`~/.heretic/agents/<agent>.yaml`) - Full agent configuration (includes `provider` field)

Do not manually edit these files unless debugging. Use CLI commands for all changes:

```bash
heretic init              # Create/modify agent profiles interactively
heretic agents list       # List all configured agents
heretic agents show <n>   # Show profile details
heretic agents validate   # Validate configuration
heretic agents delete <n> # Delete agent, containers, and associated files
```

This ensures consistent configuration and proper secret handling.

## Installation

### Install via npm (recommended)

Heretic CLI requires [Bun](https://bun.sh/) as its runtime.

```bash
# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install heretic-cli globally
bun install -g heretic-cli
```

### Update

```bash
bun update -g heretic-cli
```

### Build from Source (local development)

```bash
git clone <repo>
cd heretic/cli
bun install
bun run dev              # Run directly from source
bun link                 # Make available globally as heretic-cli
```

### Building Native Binaries (advanced)

For contributors or environments where a standalone binary is preferred:

```bash
cd cli
bun install
bun run build            # Build for current platform
bun run build:all        # Cross-platform builds
```

The binary is placed in `cli/dist/`. Move it to a directory in your `PATH`.

### Platform Support

| Platform | Architecture | Status |
|----------|-------------|--------|
| Linux | x64, arm64 | Supported |
| macOS | x64, arm64 | Supported |
| Windows | x64, arm64 | Supported |

**Note:** Windows requires Docker Desktop with WSL 2 backend for optimal compatibility.

## Quick Start

```bash
# 1. Initialize global settings and create your first agent profile
heretic init

# 2. In your project directory, create local config
cd /path/to/project
heretic local-init claude

# 3. Run the agent
heretic run claude
# or simply:
heretic claude
```

## Commands

### `heretic init`

Interactive wizard to set up global settings (`~/.heretic/settings.yaml`) and create agent profiles.

#### Token Security

All tokens (GitHub, Copilot, API keys) are stored as **script paths**, never as raw values:

```yaml
# ~/.heretic/settings.yaml - stores script paths, not raw tokens
github:
  token: /Users/you/.heretic/get-github-token-key.sh
  copilot_token: /Users/you/.heretic/get-copilot-token-key.sh
```

The wizard creates executable scripts that output the token. Replace the default `echo` with a secure method:

**Unix (`.sh`)**:
```bash
# macOS Keychain
security find-generic-password -s 'github-token' -w

# 1Password CLI
op read 'op://vault/github/token'

# pass (Unix password manager)
pass show github/token
```

**Windows (`.cmd`)**:
```cmd
@echo off
REM 1Password CLI
op read "op://vault/github/token"
```

**PowerShell (`.ps1`)** — manually create if preferred:
```powershell
# Windows Credential Manager
(Get-StoredCredential -Target "github-token").GetNetworkCredential().Password
```

The secret execution engine automatically selects the correct shell based on script extension:
- `.sh` → `bash` (on Windows: Git Bash or WSL)
- `.cmd` / `.bat` → `cmd.exe`
- `.ps1` → `powershell -ExecutionPolicy Bypass -File`

#### Agent Types

The init wizard supports three agent types:

| Type | Description | API Token | API URL |
|------|-------------|-----------|---------|
| **Anthropic** | Direct Anthropic API | Optional — API key or OAuth token | Default (api.anthropic.com) |
| **Third-Party** | Proxy API (ZAI, Kimi, or custom) | Provider API key | Custom URL |
| **Copilot** | Custom API (no Anthropic env vars) | Custom token | Not applicable |

##### Anthropic Token Types

When an Anthropic token is provided during `heretic init`, you choose the type:

| Token Type | Env Vars Set | Use Case |
|------------|-------------|----------|
| **API Key** | `ANTHROPIC_API_KEY` → mapped to `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_AUTH_KEY` | Pay-per-use API billing |
| **OAuth Token** | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN=""`, `ANTHROPIC_BASE_URL=""` | Claude subscription (Pro/Team) |

The empty `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` values are intentional — they prevent Claude Code from falling back to API mode when using an OAuth/subscription token.

If no token is provided, the profile is created without token env vars and can be configured later.

#### Third-Party Providers

Third-party agents support multiple API providers through presets:

| Preset | Default URL | Default Model |
|--------|-------------|---------------|
| **ZAI** | `https://api.z.ai/api/anthropic` | `glm-4.7` |
| **Kimi** | `https://api.moonshot.ai/anthropic` | `kimi-k2.5` |
| **Custom** | (user enters) | (user enters) |

##### Configuration Flow

1. **Select preset** - Choose ZAI, Kimi, or Custom
2. **Enter agent name** - Default based on preset (e.g., `claude-zai`, `claude-kimi`)
3. **Enter API URL** - Pre-filled for ZAI/Kimi, manual for Custom
4. **Enter API token** - Your provider's API key
5. **Enter Docker image** - Default: `giglabo/claude-heretic`
6. **Choose model config method**:
   - **Environment Variables** - Model env vars in agent profile YAML
   - **Settings JSON** - Model env vars in Claude settings.json file
7. **Enter model name** - Pre-filled based on preset
8. **Customize environment variables** - Review and modify preset defaults

##### Environment Variable Customization

Each preset comes with predefined environment variables. During setup, you can:

- **Keep defaults as-is** - Use the preset values without changes
- **Modify default values** - Change the values of existing env vars
- **Add more env vars** - Add additional custom environment variables

Default env vars for all presets:
```
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
API_TIMEOUT_MS=600000
```

Model-related env vars (set to your chosen model):
```
ANTHROPIC_MODEL
ANTHROPIC_SMALL_FAST_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
CLAUDE_CODE_SUBAGENT_MODEL
```

You can add any custom env vars needed for your provider during the configuration wizard.

#### Agent Settings

All agent types support an optional path to an existing `settings.json` file during setup:
- If provided, your settings are copied and used as the base
- If not provided, default settings with permissions are created

**Copilot agents** do not set any `ANTHROPIC_*` environment variables. Instead, the agent's API token is exposed as `<NAME>_TOKEN` (e.g., `MYAGENT_TOKEN`).

The wizard prints what will be added so you can verify the changes.

### `heretic local-init [profile]`

Scaffolds per-project configuration in `.heretic/cli/`. Each profile gets its own file:

```bash
heretic local-init claude          # Create .heretic/cli/claude.yaml
heretic local-init copilot         # Create .heretic/cli/copilot.yaml (no conflict)
heretic local-init --compose       # Create .heretic/cli/compose.yaml for custom runner
heretic local-init claude --force  # Overwrite existing files
```

Creates:
- `.heretic/cli/<profile>.yaml` — per-profile local overrides
- `.heretic/cli/temp/` — runtime temp directory for generated files (e.g., `.mcp.json`)
- `.heretic/cli/claude-settings.json` — local Claude settings (auto-merged with global)

You can call `local-init` multiple times with different profiles to create overrides for each.

Add `.heretic/cli/` to your `.gitignore`.

#### Claude Settings Merge

Local settings (`.heretic/cli/claude-settings.json`) are **automatically detected and merged** with global settings at runtime:

- **Arrays** (permissions.allow, permissions.deny): Union (combined, deduplicated)
- **Objects** (env): Shallow merge (local overrides global)
- **Primitives**: Local replaces global

Example local settings for third-party providers (override models):
```json
{
  "permissions": {
    "allow": ["mcp__project-specific"]
  },
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "different-model"
  }
}
```

Example local settings for Anthropic (add permissions):
```json
{
  "permissions": {
    "allow": ["mcp__custom-server"],
    "deny": ["Bash(rm -rf *)"]
  }
}
```

The template generated by `local-init` is profile-aware (Anthropic, Third-Party, or Copilot).

### `heretic run <agent-name>`

Start an agent container using the resolved configuration.

```bash
heretic run claude                 # Interactive mode
heretic run claude -d              # Detached (background) mode
heretic run claude -s feature-x   # Run in named session
heretic run claude --mcp mcp.json  # Override MCP config from file
heretic run claude --mcp '[{"name":"fs","command":"npx","args":["-y","@mcp/server-fs"]}]'
heretic run claude -- echo hello   # Override container command
```

Shorthand: any unknown command is treated as `run`:

```bash
heretic claude                     # Same as: heretic run claude
heretic claude -d                  # Same as: heretic run claude -d
heretic claude -s feature-x       # Same as: heretic run claude -s feature-x
```

### `heretic ps`

List running agent containers.

```bash
heretic ps
heretic ps --json
heretic ps -s feature-x           # Filter by session name
```

### `heretic stop [name]`

Stop running agent containers.

```bash
heretic stop claude          # Stop a specific agent
heretic stop --all           # Stop all heretic containers
heretic stop claude --keep   # Stop but don't remove the container
heretic stop claude -f       # Skip confirmation
heretic stop -s feature-x   # Stop container(s) in a specific session
```

### `heretic attach <name>`

Attach to a running agent container's TTY.

```bash
heretic attach claude
heretic attach claude -s feature-x  # Attach to session-specific container
```

### `heretic agents`

Manage global agent profiles stored in `~/.heretic/agents/`.

```bash
heretic agents list             # List all profiles
heretic agents list --json      # JSON output
heretic agents add <name>       # Create a new profile (interactive)
heretic agents edit <name>      # Edit a profile
heretic agents edit <name> --editor  # Open in $EDITOR
heretic agents show <name>      # Display profile config
heretic agents show <name> --resolved  # Show after interpolation
heretic agents show <name> --reveal    # Show sensitive values
heretic agents delete <name>           # Delete agent (with confirmation)
heretic agents delete <name> -f        # Delete without confirmation
heretic agents validate         # Validate all profiles
heretic agents validate <name>  # Validate a specific profile
heretic agents mcp <name>              # Paste MCP JSON, update global profile
heretic agents mcp <name> --local      # Paste MCP JSON, update local override
heretic agents mcp <name> --file mcp.json  # Read MCP JSON from file
```

#### Deleting an Agent

`heretic agents delete <name>` removes an agent and all associated resources:

1. **Stops and removes** all running/stopped containers for the agent (found by `heretic.agent=<name>` label)
2. **Deletes** the profile YAML (`~/.heretic/agents/<name>.yaml`)
3. **Deletes** secret scripts (`get-<name>-key.sh` / `.cmd`)
4. **Deletes** Claude settings (`<name>-settings.json`)

Use `-f` / `--force` to skip the confirmation prompt.

#### Adding MCP Servers via Paste

The `agents mcp` subcommand lets you paste MCP server JSON (copied from Claude, VS Code, Copilot, etc.) and merge it into a profile or local override.

```bash
# Paste JSON interactively (opens $EDITOR)
heretic agents mcp claude

# Read from a file
heretic agents mcp claude --file ~/mcp-servers.json

# Apply to local override instead of global profile
heretic agents mcp claude --local
heretic agents mcp claude --local --file .vscode/mcp.json
```

**Note:** The paste mode opens `$EDITOR` (falls back to `vi`). If your `$EDITOR` is not installed, override it:

```bash
EDITOR=vim heretic agents mcp claude
```

Or skip the editor entirely with `--file`:

```bash
heretic agents mcp claude --file /tmp/mcp.json
```

**Supported JSON formats** (auto-detected):

```json
// Claude / Copilot CLI format
{ "mcpServers": { "server-name": { "command": "npx", "args": [...] } } }

// VS Code format
{ "servers": { "server-name": { "command": "npx", "args": [...] } } }

// Bare server map
{ "server-name": { "command": "npx", "args": [...] } }
```

**Merge strategy**: Servers are merged by name. New servers with the same name replace existing ones; new names are appended.

When using `--local`, if no `.heretic/cli/<name>.yaml` exists yet, one is created with `extends: <profile-name>`.

### `heretic local-validate [profile]`

Validate local `.heretic/cli/` configuration(s) against their parent profiles.

```bash
heretic local-validate             # Validate all local configs
heretic local-validate claude      # Validate just the claude local override
```

### `heretic doctor`

Run environment health checks (Docker availability, profile validity, etc.).

```bash
heretic doctor
heretic doctor --fix    # Auto-fix issues where possible
```

### `heretic update`

Check for and install CLI updates. If installed via npm/bun, directs you to use `bun update -g heretic-cli` instead.

## Global Options

```
-v, --version       Show version
-V, --verbose       Enable verbose (debug) logging
--log-file <path>   Write logs to a file
```

## Sessions

Sessions allow running multiple isolated agent instances from the same project directory. Each session gets its own temp directory and container.

### How It Works

- **Default session**: When `--session` is omitted, the session name is `"default"`
- **Session directory**: Temp files (MCP config, Claude settings, compose YAML) are stored in `.heretic/temp/<session>/` inside the project
- **Container naming**: Containers are named `heretic-<agent>-<session>-<hash8>` where hash is derived from the project directory
- **Container label**: Every container gets a `heretic.session=<name>` label for filtering

### Usage

```bash
# Run two agents in parallel in different sessions
heretic run claude -s feature-a
heretic run claude -s feature-b

# List all containers (shows SESSION column)
heretic ps

# Filter by session
heretic ps -s feature-a

# Stop a specific session
heretic stop -s feature-a

# Attach to a session-specific container
heretic attach claude -s feature-a
```

### File Structure

```
your-project/
  .heretic/
    temp/
      default/                  # Default session temp files
        .mcp.json
        claude-settings.json
        compose.yaml
      feature-a/                # Named session temp files
        .mcp.json
        claude-settings.json
```

## Configuration

### Three-Layer Config Model

Configuration is resolved by merging three layers (later wins):

1. **Global profile** — `~/.heretic/agents/<name>.yaml`
2. **Local override** — `.heretic/cli/<profile>.yaml` (per-project, per-profile)
3. **CLI flags** — command-line options like `--mcp`

### Variable Interpolation

String values support `${VAR}` placeholders resolved after merge:

| Variable | Value |
|----------|-------|
| `${CWD}` | Project directory (where you run the command) |
| `${HOME}` | User home directory |
| `${ANY_ENV_VAR}` | Value from `process.env` |

Escape with double dollar: `$${LITERAL}` becomes `${LITERAL}`.

### Merge Rules

| Field | Strategy | Description |
|-------|----------|-------------|
| `image` | Replace | Later value wins |
| `runner` | Replace | `"docker"`, `"compose"`, or `"custom"` |
| `agent_type` | Replace | `"claude"`, `"aider"`, `"copilot-cli"`, or `"generic"` |
| `provider` | Replace | `"anthropic"`, `"thirdparty"`, or `"copilot"` |
| `volumes` | Replace | Entire array is replaced |
| `env` | Shallow merge | Keys are merged, later wins on conflict |
| `workdir` | Replace | |
| `command` | Replace | |
| `interactive` | Replace | |
| `tty` | Replace | |
| `extra` | Shallow merge | Top-level keys merged; `ports`/`capabilities` replace; `labels` shallow-merge |
| `compose` | Deep merge | Recursive object merge |
| `ssh` | Shallow merge | Individual fields override |
| `mcp` | Replace | Entire array is replaced |
| `mcp_file` | Replace | Path to MCP JSON file |
| `mcp_override` | Replace | Boolean |
| `git` | Shallow merge | Individual fields override |
| `dind` | Replace | Boolean |
| `secrets` | Shallow merge | Keys are merged, later wins on conflict |
| `claude_settings` | Replace | Path to Claude Code settings.json |

## Agent Profile Reference

### Minimal Profile

```yaml
image: giglabo/claude-heretic:latest
runner: docker
```

### Full Profile

```yaml
image: giglabo/claude-heretic:latest
runner: docker
agent_type: claude
provider: anthropic  # anthropic | thirdparty | copilot
description: "Claude agent with full tooling"

# Secrets - scripts that output sensitive values (not stored in YAML)
secrets:
  ANTHROPIC_API_KEY: "~/.heretic/get-anthropic-key.sh"
  ZAI_API_KEY: "~/.heretic/get-secret.sh zai"

volumes:
  - source: "${CWD}"
    target: /workspace
    readonly: false
  - source: "${CWD}/.env"
    target: /workspace/.env
    readonly: true

env:
  # Secrets from scripts are available via ${VAR}
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
  NODE_ENV: development

workdir: /workspace
command: ["--profile", "default"]
interactive: true
tty: true

extra:
  network: host
  ports:
    - "3000:3000"
    - "5173:5173"
  capabilities:
    - SYS_PTRACE
  privileged: false
  user: "1000:1000"
  hostname: heretic-agent
  memory: "4g"
  cpus: "2.0"
  shm_size: "2g"
  labels:
    team: platform

ssh:
  host: dev-server.example.com
  port: 22
  user: agent
  key_path: "${HOME}/.ssh/id_rsa"
  host_cwd: /home/agent/workspace

mcp_file: ~/shared/mcp-servers.json  # Load MCP servers from JSON file
mcp:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GH_TOKEN}"

mcp_override: false

git:
  token: "${GH_TOKEN}"
  author_name: "Heretic Agent"
  author_email: "agent@example.com"

dind: false
claude_settings: ~/.heretic/claude-settings.json

compose:
  services:
    redis:
      image: redis:7-alpine
      ports:
        - "6379:6379"
```

### Agent Type

The `agent_type` field determines agent-specific behavior, such as where MCP configuration files are mounted inside the container.

| Type | MCP Config | Mount Path(s) | Description |
|------|-----------|---------------|-------------|
| `claude` (default) | `.mcp.json` | `/workspace/.mcp.json` | Claude Code agent |
| `aider` | `.mcp.json` | `/workspace/.mcp.json` | Aider agent |
| `copilot-cli` | `mcp-config.json` | `~/.copilot/mcp-config.json` | GitHub Copilot CLI agent |
| `generic` | `.mcp.json` | `/workspace/.mcp.json` | Generic/custom agent |

```yaml
agent_type: claude  # Default, can be omitted
```

The `copilot-cli` agent type mounts the MCP config to `~/.copilot/mcp-config.json` (both `/root/.copilot/` and `/home/agent/.copilot/`) since Copilot CLI reads MCP configuration from its home directory rather than the workspace.

### SSH

Configures SSH environment variables and key mounting for agents that connect to remote hosts.

| Field | Default | Description |
|-------|---------|-------------|
| `host` | (required) | SSH hostname |
| `port` | `22` | SSH port |
| `user` | `"agent"` | SSH username |
| `key_path` | — | Absolute path to private key; mounted read-only at `/home/agent/.ssh/id_rsa` |
| `host_cwd` | — | Working directory on the remote host |

Container receives: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY_PATH`, `SSH_HOST_CWD`.

### MCP (Model Context Protocol)

Defines MCP servers available inside the container. The CLI generates a `.mcp.json` file in `.heretic/cli/temp/` and mounts it read-only at `/workspace/.mcp.json`.

```yaml
mcp:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  - name: custom-server
    command: /usr/local/bin/my-mcp-server
    env:
      API_KEY: "${MY_API_KEY}"
```

#### MCP File (`mcp_file`)

Instead of defining MCP servers inline, you can point to an existing JSON file containing MCP server definitions. The CLI auto-detects three JSON formats:

| Format | Top-level key | Used by |
|--------|--------------|---------|
| `{ "mcpServers": { ... } }` | `mcpServers` | Claude Code, Copilot CLI |
| `{ "servers": { ... } }` | `servers` | VS Code |
| `{ "name": { "command": ... } }` | (bare map) | Custom |

Each server entry must have a `command` field. Optional `args` and `env` are passed through. Extra fields (e.g., `type`, `cwd`) are silently ignored.

```yaml
# Reference an existing MCP config
mcp_file: ~/projects/my-app/.vscode/mcp.json
```

When both `mcp_file` and inline `mcp` are specified, they are merged by server name. Inline servers override file servers with the same name, and new inline servers are appended:

```yaml
mcp_file: ~/shared/mcp-servers.json
mcp:
  - name: trello           # overrides "trello" from file
    command: /usr/local/bin/npx
    args: ["-y", "mcp-remote", "http://localhost:9090/sse"]
  - name: extra-server      # appended (not in file)
    command: npx
    args: ["-y", "my-mcp-server"]
```

The `mcp_file` path supports `${VAR}` interpolation:

```yaml
# Use project-relative path
mcp_file: ${CWD}/.vscode/mcp.json
```

#### Existing Workspace MCP Config

By default, if a `.mcp.json` file already exists in your project root, the CLI will **skip** mounting the generated MCP config and use your existing file instead. This allows you to maintain project-specific MCP configurations that take precedence over profile-defined servers.

To force the CLI to use the profile-defined MCP servers and override any existing workspace `.mcp.json`, set `mcp_override: true`:

```yaml
mcp:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]

mcp_override: true  # Override existing .mcp.json in workspace
```

| Scenario | Behavior |
|----------|----------|
| No existing MCP config in workspace | Mount generated config from profile |
| Existing MCP config found, `mcp_override: false` (default) | Skip mounting, use existing file |
| Existing MCP config found, `mcp_override: true` | Mount generated config, override existing |

The existing config path checked depends on `agent_type`: `.mcp.json` for Claude/Aider/generic, `.copilot/mcp-config.json` for `copilot-cli`.

#### Runtime Override

Override at runtime with `--mcp`:

```bash
# From a JSON file
heretic run claude --mcp ./my-servers.json

# Inline JSON
heretic run claude --mcp '[{"name":"fs","command":"npx","args":["-y","@mcp/server-fs"]}]'
```

The JSON file/string must be an array of server objects with `name` and `command` fields.

#### Generated File Format

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    }
  }
}
```

### Git

Sets Git-related environment variables inside the container.

| Field | Env Var | Description |
|-------|---------|-------------|
| `token` | `GH_TOKEN`, `GITHUB_TOKEN` | GitHub/Git authentication token (overrides global settings) |
| `author_name` | `GIT_AUTHOR_NAME` | Commit author name |
| `author_email` | `GIT_AUTHOR_EMAIL` | Commit author email |

Only non-empty values are set.

### GitHub Token Injection

All agent containers receive GitHub tokens from global settings (`~/.heretic/settings.yaml`). **Copilot tokens are only injected for agents with `provider: copilot`.**

| Env Var | Source | Injected For |
|---------|--------|-------------|
| `GH_TOKEN` | `github.token` | All agents |
| `GITHUB_TOKEN` | `github.token` | All agents |
| `GH_COPILOT_TOKEN` | `github.copilot_token` | `provider: copilot` only |
| `GITHUB_COPILOT_TOKEN` | `github.copilot_token` | `provider: copilot` only |

**Fallback:** If `copilot_token` is not configured, copilot agents use the primary `github.token` for `GH_COPILOT_TOKEN` and `GITHUB_COPILOT_TOKEN`.

**Override priority:** Per-agent `git.token` in the profile overrides the global `GH_TOKEN` and `GITHUB_TOKEN` for that agent.

**Provider inference:** If a profile lacks a `provider` field, it is inferred from `agent_type` (`copilot-cli` → `copilot`, all others → `anthropic`). Always include `provider` explicitly in profiles.

### Secrets

The `secrets` field maps environment variable names to **secret sources**. Each value can be a script path, an environment variable reference, or a plain value.

#### Secret Value Modes

| Mode | Syntax | Example |
|------|--------|---------|
| **Script** | Path ending in `.sh`, `.cmd`, `.ps1`, `.bat` | `~/.heretic/get-key.sh` |
| **Env var** | `$VAR` or `${VAR}` (entire value) | `$MY_HOST_TOKEN` |
| **Plain** | Anything else | `sk-ant-api03-abc123...` |

```yaml
secrets:
  # Script (executed, stdout is the value)
  ANTHROPIC_API_KEY: "~/.heretic/get-anthropic-key.sh"
  ZAI_API_KEY: "~/.heretic/get-secret.sh zai"

  # Env var reference (resolved from host environment)
  GH_TOKEN: "$GITHUB_TOKEN"

  # Plain value (used as-is)
  CUSTOM_KEY: "my-api-key-12345"
```

**Windows scripts:**
```yaml
secrets:
  ANTHROPIC_API_KEY: "C:\\Users\\you\\.heretic\\get-anthropic-key.cmd"
```

**How it works:**

1. Before starting the agent, the CLI executes each script
2. The script's stdout (trimmed) becomes the environment variable value
3. Resolved secrets are merged into the variable context for `${VAR}` interpolation
4. Secrets are passed as environment variables to the container

**Script requirements:**

- Must be executable (`chmod +x` on Unix; `.cmd`/`.ps1` on Windows)
- Must output the secret value to stdout (single line, no trailing newline needed)
- Must exit with code 0 on success
- Has a 30-second timeout
- Can accept arguments: `"~/.heretic/get-secret.sh my-key-name"`

**Cross-platform execution:** The secret engine selects the correct shell based on file extension:

| Extension | Unix | Windows |
|-----------|------|---------|
| `.sh` | Default shell | `bash` (Git Bash / WSL) |
| `.cmd` / `.bat` | N/A | `cmd.exe` |
| `.ps1` | N/A | `powershell -ExecutionPolicy Bypass -File` |

**Example scripts (Unix):**

```bash
#!/bin/bash
# ~/.heretic/get-anthropic-key.sh — 1Password CLI
op read 'op://Personal/Anthropic API/credential'
```

```bash
#!/bin/bash
# ~/.heretic/get-secret.sh — macOS Keychain
security find-generic-password -s "heretic-$1" -w
```

```bash
#!/bin/bash
# ~/.heretic/get-gh-token.sh — GitHub CLI
gh auth token
```

```bash
#!/bin/bash
# ~/.heretic/get-secret.sh — pass (GPG-encrypted password store)
pass show "heretic/$1"
```

```bash
#!/bin/bash
# ~/.heretic/get-aws-secret.sh — AWS Secrets Manager
aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text
```

**Example scripts (Windows):**

```cmd
@echo off
REM ~/.heretic/get-anthropic-key.cmd — 1Password CLI
op read "op://Personal/Anthropic API/credential"
```

```powershell
# ~/.heretic/get-gh-token.ps1 — GitHub CLI
gh auth token
```

**Using secrets in env:**

Resolved secrets are available for `${VAR}` interpolation:

```yaml
secrets:
  ANTHROPIC_API_KEY: "~/.heretic/get-anthropic-key.sh"

env:
  # Reference the resolved secret
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
  # Or use directly (secrets are auto-injected into container env)
```

**Note:** Secrets are resolved at runtime, not stored. If a script fails, the agent won't start.

### Docker-in-Docker (DinD)

When `dind: true`, mounts the host Docker socket into the container at `/var/run/docker.sock`.

The CLI automatically detects the correct Docker socket path for your platform:
- **Linux**: `/var/run/docker.sock`
- **macOS**: `~/.docker/run/docker.sock` or `/var/run/docker.sock`
- **Windows**: `//./pipe/docker_engine`

This allows the agent to run Docker commands inside its container.

### Runner Types

**`docker`** — Single container managed via Docker API (dockerode). Default.

**`compose`** — Multi-container setup. Generates a temporary `docker-compose.yaml` from the profile and shells out to `docker compose`. Use `compose.services` to define sidecar services.

**`custom`** — Uses a user-provided compose file at `.heretic/cli/compose.yaml`. Create it with `heretic local-init --compose`.

## Local Override

Each profile can have its own local override file: `.heretic/cli/<profile>.yaml`. The profile name is inferred from the filename (e.g., `claude.yaml` extends the `claude` global profile). You can also include an explicit `extends` field.

Legacy `.heretic/cli/agent.yaml` with an `extends` field is still supported as a fallback. Per-profile files take precedence.

```yaml
# .heretic/cli/claude.yaml — local override for "claude" profile

# Project-specific secrets (merged with profile secrets)
secrets:
  PROJECT_API_KEY: "~/.heretic/get-project-key.sh"

env:
  PROJECT_NAME: my-app
  DEBUG: "app:*"

# Load MCP servers from project's VS Code config
mcp_file: ${CWD}/.vscode/mcp.json

# Inline MCP servers (merged with mcp_file servers by name)
mcp:
  - name: project-docs
    command: npx
    args: ["-y", "@mcp/server-filesystem", "/workspace/docs"]

mcp_override: true  # Force profile MCP servers even if .mcp.json exists

git:
  author_name: "Project Bot"

dind: true
```

**Notes:**
- If your project already has a `.mcp.json` file and you want to use it as-is inside the container, omit the `mcp` section or set `mcp_override: false` (the default).
- When `mcp_file` is set alongside inline `mcp`, servers are merged by name: inline entries override file entries with the same name, new entries are appended.

## Project Directory Structure

```
~/.heretic/
  settings.yaml              # Global CLI settings (GitHub tokens, etc.)
  agents/
    claude.yaml              # Global agent profile (includes provider field)
    custom-agent.yaml        # Another profile
  get-anthropic-key.sh       # Secret script - Unix (created by `heretic init`)
  get-anthropic-key.cmd      # Secret script - Windows (created by `heretic init`)
  get-github-token-key.sh    # Secret script
  claude-settings.json       # Global Claude Code settings (includes "model": "opus")

your-project/
  .heretic/
    cli/
      claude.yaml            # Local overrides for "claude" profile
      copilot.yaml           # Local overrides for "copilot" profile
      compose.yaml           # Custom compose file (for "custom" runner)
      claude-settings.json   # Local Claude settings (auto-merged with global)
    temp/                    # Runtime temp files (per-session subdirs)
      default/               # Default session temp files
        .mcp.json            # Generated MCP config (auto-managed)
        .claude.json         # Onboarding seed (hasCompletedOnboarding: true)
        settings.json        # Merged Claude settings
        compose.yaml         # Generated compose file (compose runner)
  .gitignore                 # Should include .heretic/cli/ and .heretic/temp/
```

## Validation

Profiles are validated at load time and when running `heretic agents validate` or `heretic local-validate`. Checked rules include:

- `image` is non-empty
- `runner` is one of `docker`, `compose`, `custom`
- `agent_type` is one of `claude`, `aider`, `copilot-cli`, `generic`
- `provider` is one of `anthropic`, `thirdparty`, `copilot` (when specified)
- Volume sources are absolute paths (after interpolation)
- Env var values are strings
- `ssh.host` non-empty when ssh is present
- `ssh.port` between 1-65535
- `ssh.key_path` is an absolute path
- `mcp[].name` and `mcp[].command` are non-empty
- `mcp_file` is a non-empty string when specified
- `mcp_override` is a boolean when specified
- `git.token` is non-empty when specified
- `secrets` is an object with string values (script paths)
- `secrets` values are non-empty strings

## Container Onboarding

For non-copilot agents (`claude`, `aider`, `generic`), the CLI automatically:

1. Seeds `.claude.json` with `{ "hasCompletedOnboarding": true }` in the session directory
2. Bind-mounts it to `/home/agent/.claude.json` and `/root/.claude.json`

This skips Claude Code's interactive login/onboarding screen. The onboarding seed is created once per session and reused on subsequent runs.

## Troubleshooting

Run `heretic doctor` to diagnose common issues. Use `--verbose` on any command for debug output:

```bash
heretic run claude --verbose
heretic doctor --fix
```

### Common Issues

**Copilot tokens missing from copilot containers:** Ensure the agent profile has `provider: copilot`. Copilot tokens are only injected for agents with this provider. If the `provider` field is missing, it is inferred from `agent_type` (`copilot-cli` → `copilot`).

**Claude Code shows login screen:** The `.claude.json` onboarding seed may be missing. Delete the session directory (`.heretic/temp/<session>/`) and re-run the agent.

**Empty env vars overriding container defaults:** The CLI filters empty env vars except for intentionally empty ones set in `config.env` (e.g., `ANTHROPIC_AUTH_TOKEN: ""` for OAuth mode). Use `--verbose` to see which env vars are being set.

**Secret script fails on Windows:** Ensure the script extension matches the expected shell (`.cmd` for cmd.exe, `.ps1` for PowerShell, `.sh` for Git Bash/WSL).
