---
name: heretic-local-config
description: Complete reference for project-local heretic configuration — `local-init` (per-profile override and `--compose` template), `local-validate`, the .heretic/ directory layout, the three-layer merge order and per-field merge rules, ${VAR} interpolation with escaping, secrets resolution modes, validateResolvedConfig error strings, the legacy agent.yaml fallback, and the all-comments template trap. Use when creating or debugging .heretic/cli/*.yaml, understanding which layer wins, why a resolved value is empty, or why a fresh local-init breaks `run`.
---

# Project-local config: `local-init`, `local-validate`, and config resolution

```
heretic-cli local-init [profile] [--compose] [-f|--force]
heretic-cli local-validate [profile]
```

Sources: `cli/src/commands/localInit.ts`, `cli/src/commands/local-validate.ts`,
`cli/src/utils/local-config.ts`, `cli/src/utils/config-resolver.ts`,
`cli/src/utils/interpolation.ts`.

## Directory layout

```
<project>/.heretic/
├── cli/
│   ├── <profile>.yaml          per-profile override — PREFERRED. `extends:` inferred from filename
│   ├── agent.yaml              legacy single override; only applies when `extends:` matches the profile
│   ├── compose.yaml            RESERVED — used verbatim by runner: custom
│   └── claude-settings.json    RESERVED — auto-merged over the global claude settings at run time
└── temp/<session>/             generated per run (0777): .mcp.json, settings.json, .claude.json,
                                compose.yaml, entrypoint.sh
```

`listLocalConfigs()` treats every `*.yaml`/`*.yml` in `.heretic/cli/` as a profile name,
**except** the two reserved filenames; `agent.yaml` is resolved to whatever its `extends:`
says. Add `.heretic/cli/` to `.gitignore` — `local-init` suggests this when a `.gitignore`
exists and does not already list it.

## `local-init [profile]`

**Per-profile mode (default).** With no argument it lists the global profiles and prompts
you to pick one; with an argument it verifies the profile exists
(`Profile '<x>' not found in ~/.heretic/agents/` + `Available profiles: …` → exit 1).
Refuses to overwrite without `--force`: `File already exists: <path>` + `Use --force to overwrite`.

Creates:

1. `.heretic/cli/` and `.heretic/temp/` (session subdirs are created on demand by runners).
2. `.heretic/cli/claude-settings.json` — only if absent, or always with `--force`:

```json
{
  "dangerouslySkipPermissions": true,
  "enabledMcpjsonServers": [],
  "allowedTools": ["Bash","Edit","Write","Read","Glob","Grep","WebFetch","WebSearch","mcp__*"]
}
```

   The provider (`anthropic`/`thirdparty`/`copilot`, detected from the profile's `provider`
   field, else from a non-empty `ANTHROPIC_BASE_URL` in `env`) only changes the log label —
   the template is identical for all three.
3. `.heretic/cli/<profile>.yaml` — a **fully commented** template documenting `secrets`,
   `env`, `volumes`, `workdir`, `command`, `extra`, `ssh`, `mcp`, `git`, `dind`.

Also notes when a legacy `.heretic/cli/agent.yaml` exists:
`Note: Legacy .heretic/cli/agent.yaml exists. Per-profile file <x>.yaml takes precedence.`

> ### ⚠ The all-comments trap (verified)
> The generated `<profile>.yaml` contains **only comments**, so YAML parses it as `null`.
> `hasLocalConfig()` returns true because the file exists, and `loadLocalConfig()` then
> throws. Immediately after `local-init`, both of these fail:
>
> ```
> $ heretic-cli local-validate
> ERROR: Unexpected error: Failed to load local config from …/.heretic/cli/probe.yaml: Invalid config: expected an object
> $ heretic-cli run probe
> ERROR: Failed to run agent 'probe': Failed to load local config from …/.heretic/cli/probe.yaml: Invalid config: expected an object
> ```
>
> **Fix:** uncomment at least one key (or write `extends: <profile>`). Minimal valid file:
> ```yaml
> extends: probe
> env:
>   FOO: bar
> ```
> Deleting the file also works — the global profile alone is a complete config.

**Compose mode.** `local-init --compose` ignores the profile argument and writes
`.heretic/cli/compose.yaml`: a `version: "3.8"` file with an `agent` service
(`giglabo/claude-heretic:latest`, `.:/workspace`, `ANTHROPIC_API_KEY` passthrough,
`stdin_open`, `tty`, `working_dir: /workspace`, `network_mode: host`) plus commented `db`
and `redis` examples. This file is what `runner: custom` executes **verbatim**.

## `local-validate [profile]`

With a profile: validates that one. Without: discovers every local config via
`listLocalConfigs()` and validates each; exit 0 only if all pass
(`No local config files found in .heretic/cli/` + `Run 'heretic-cli local-init <profile>' to create one.` → exit 1).

Steps per profile: file exists → load → require `extends` → `resolveConfig()` →
`validateResolvedConfig()` → summary → **full resolved YAML dump**:

```
Validating local config for profile "probe"...
  Extends: probe
  Image: giglabo/claude-heretic:latest
  Runner: docker
  Volumes: 1 mount(s)
  Env: 1 variable(s)

✓ All checks passed.

Resolved configuration:
────────────────────────────────────────────────────────────
name: probe
projectDir: /abs/project
sessionName: default
image: giglabo/claude-heretic:latest
runner: docker
agentType: claude
provider: anthropic
volumes: [...]
env: {...}
…
────────────────────────────────────────────────────────────
```

This dump is the **most complete** view available (more than `agents show --resolved`) — it
includes `mcp`, `ssh`, `toolBackends`, `git`, `dind`, `secrets`, `claudeSettings`.
⚠ It prints resolved **secret values in plaintext**. Don't paste into tickets/CI logs.

Errors carry hints via `HereticError.suggestion`:
`💡 Run 'heretic-cli local-init <profile>' to create a local override.`,
`💡 Run 'heretic-cli local-validate' to see all issues.`

## The three-layer merge

```
global profile (~/.heretic/agents/<name>.yaml)
      ↓  mergeConfigs
local override (.heretic/cli/<name>.yaml  or legacy agent.yaml with matching extends)
      ↓  mergeConfigs
CLI overrides (--mcp, --root, --sidecar/--builder-image/--disable-sidecars)
      ↓
${VAR} interpolation over the whole merged object (AFTER merge, using CWD/HOME/process.env + resolved secrets)
      ↓
mcp_file merge (file servers as base, inline `mcp` overrides/appends by name)
      ↓
defaults applied → ResolvedAgentConfig → validateResolvedConfig()
```

`extends` mismatch is fatal:
`Local config extends '<a>' but loading profile '<b>'`.

### Per-field merge rules (exact)

| Rule | Fields |
| --- | --- |
| **Replace** (override wins entirely) | `image`, `runner`, `agent_type`, `provider`, `volumes` (whole array), `workdir`, `command`, `interactive`, `tty`, `mcp` (whole array), `mcp_file`, `mcp_override`, `dind`, `claude_settings` |
| **Shallow merge** (per key) | `env`, `extra`, `ssh`, `git`, `secrets`, `extra.labels` |
| **Replace inside `extra`** | `extra.ports`, `extra.capabilities` |
| **Deep merge** | `compose` (recursive objects; arrays and primitives replace) |
| **Scalars merge, `sidecars` replaces** | `tool_backends` |

Consequences worth remembering: adding one volume locally means re-listing all of them;
`env` is additive so you can override a single variable; `extra.ports` is all-or-nothing.

## `${VAR}` interpolation

- Runs on **every string** in the merged config, recursively (objects and arrays);
  numbers/booleans/null pass through.
- Context: `CWD` (the project dir passed to `resolveConfig`), `HOME` (`os.homedir()`),
  all of `process.env`, plus **resolved secrets** (so `env: { KEY: "${MY_SECRET}" }` works).
- Unknown variable → a warning
  (`Variable "X" is undefined, resolving to empty string`) and an **empty string**. Empty
  values are then stripped from the container env unless the key was explicitly `""`.
- Escape with `$${LITERAL}` → renders `${LITERAL}`.
- Only `${VAR}` braces are recognized in config strings; bare `$VAR` is left alone (bare
  `$VAR` *is* recognized in `secrets` values as an env-var reference — different code path).

## Secrets resolution (fail-fast, before interpolation)

| Value shape | Behavior |
| --- | --- |
| ends in `.sh` `.cmd` `.ps1` `.bat` (first whitespace-delimited token) | executed with a 30 s timeout; stdout trimmed. `~` expanded. Args allowed and quoted: `~/.heretic/get-secret.sh zai` |
| `$VAR` or `${VAR}` (whole string) | read from `process.env`; **throws** if unset |
| anything else | used literally |

Windows shell selection: `.sh` → `bash` (Git Bash/WSL), `.ps1` →
`powershell -ExecutionPolicy Bypass -File`, `.cmd`/`.bat` → cmd.exe. Unix always uses the
default shell. Errors: `Secret script not found: <path>`,
`Secret script failed (<path>): <stderr>`,
`Secret "X": environment variable "Y" is not set`. Empty output → warning only.

## `validateResolvedConfig()` — the complete error list

- `Image must be non-empty`
- `Invalid runner type: <x> (must be one of: docker, compose, custom)`
- `Invalid agent type: <x> (must be one of: claude, aider, copilot-cli, generic)`
- `Volume[i].source must be non-empty` / `Volume[i].source must be an absolute path: <p>` /
  `Volume[i].target must be non-empty`
- `ssh.host must be non-empty` / `ssh.port must be between 1 and 65535` /
  `ssh.key_path must be an absolute path: <p>`
- `tool_backends.sidecars[i].runtime '<x>' is invalid (must be one of: node, python, java, go, rust)`
- `tool_backends.sidecars[i]: duplicate runtime '<x>'`
- `tool_backends.sidecars[i].image must be non-empty`
- `tool_backends.sidecars[i].port must be between 1 and 65535`
- `tool_backends: no volume targets '<workspace_target>' — build sidecars need the workspace bind-mounted …`
- `tool_backends.ready_timeout must be a positive number of seconds`
- `mcp[i].name must be non-empty`, `mcp[i].url must be non-empty for http transport`,
  `mcp[i].command must be non-empty`
- `git.token must be non-empty when specified`
- `Environment variable '<k>' must be a string (got <type>)` — e.g. a bare `PORT: 8080` in
  YAML becomes a number; quote it: `PORT: "8080"`

Non-fatal warning: sidecars **and** `ssh` both configured → one build would span two
filesystems (prefer one backend per project).

All errors are joined into a single throw: `Config validation failed: a, b, c`.

## Recipes

```yaml
# .heretic/cli/claude.yaml — add a project MCP server + a port, keep everything else
extends: claude
env:
  PROJECT_NAME: acme-api
extra:
  ports: ["5173:5173"]          # replaces any profile ports
mcp:
  - name: filesystem            # replaces the profile's mcp array
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
```

```yaml
# per-project secret without touching the global profile
extends: claude
secrets:
  PROJECT_TOKEN: $CI_TOKEN      # from the shell env; fails loudly if unset
env:
  PROJECT_TOKEN: ${PROJECT_TOKEN}
```

```yaml
# mount an extra read-only path — note you must re-declare the workspace volume
extends: claude
volumes:
  - { source: "${CWD}", target: /workspace }
  - { source: "${HOME}/.gitconfig", target: /home/agent/.gitconfig, readonly: true }
```

## Gotchas

- A local override file exists ⇒ it **must** parse to an object. All-comments, empty, or
  a scalar file breaks `run` and `local-validate` (see the trap above).
- `.heretic/cli/compose.yaml` and `claude-settings.json` are reserved names — a profile can
  never be called `compose` or (effectively) use those filenames.
- The legacy `agent.yaml` only applies when its `extends:` matches the profile you run; a
  per-profile file with the same name always wins.
- `local-validate` resolves with `sessionName` defaulted to `default` and never contacts
  Docker; it *does* run secret scripts.
- `doctor` also validates every local config it discovers (see `heretic-doctor`).
- There is no `local-clean`; delete `.heretic/temp/<session>` by hand to reset an agent's
  `~/.claude` state.
