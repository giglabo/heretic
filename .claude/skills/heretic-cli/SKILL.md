---
name: heretic-cli
description: Master reference and router for the heretic-cli tool (VibeCoder Heretic CLI) — global flags, the complete command map, argv parsing quirks, logging, exit codes, every file it reads/writes, container labels, and pointers to the per-section skills. Use this whenever a question involves heretic-cli as a whole, an unknown/unrouted heretic-cli command, "which heretic command does X", CLI-wide behavior (verbose, --log-file, exit codes, ~/.heretic layout), or when you need to pick the right heretic-* skill.
---

# heretic-cli — master reference

`heretic-cli` is a Bun + TypeScript CLI compiled to a native single-file executable. It
manages **containerized coding agents** (Claude Code, Copilot CLI, OpenCode, Gemini),
builds the Docker images they run in, wires **tool-execution backends** (HTTP build
sidecars / SSH), and ships a client for the **Mnemoria** memory server.

Source of truth: `cli/src/`. Entry point `cli/src/index.ts` → `cli/src/cli.ts`
(Commander.js v14). Version comes from `cli/package.json` (`0.1.0` at time of writing).

## Pick the right skill

| Topic | Skill |
| --- | --- |
| First-time setup wizard, GitHub/Copilot tokens, provider presets (ZAI/Kimi), token types | `heretic-init` |
| Profile CRUD (`agents list/add/edit/show/validate/delete/mcp`), full profile YAML schema | `heretic-agents` |
| Running an agent (`run`, bare-name shortcut), what gets mounted/injected, runners | `heretic-run` |
| `ps` / `stop` / `attach`, labels, session model, container naming | `heretic-lifecycle` |
| `local-init` / `local-validate`, `.heretic/` layout, 3-layer merge, `${VAR}`, secrets | `heretic-local-config` |
| `image build` / `image generate`, Dockerfile template, entrypoint modes | `heretic-image` |
| `image build-sidecar`, `tool_backends`, BUILD_SIDECARS, exec-server, SSH backend | `heretic-sidecars` |
| `doctor` health checks and `--fix` | `heretic-doctor` |
| `update` (two-phase self-update) | `heretic-update` |
| Mnemoria¹: global flags, `config`, auth/OIDC, `status`, output modes, exit codes | `heretic-mnemoria` |
| Mnemoria¹: `palace` / `wing` / `room` | `heretic-mnemoria-spaces` |
| Mnemoria¹: `store`/`get`/`list`/`delete`/`search`/`keyword`/`file`/`ingest` | `heretic-mnemoria-memory` |
| Mnemoria¹: `entity` / `triple` / `graph` | `heretic-mnemoria-graph` |

¹ **Branch-only.** The `mnemoria` group exists only in the `feat/mnemoria` branch
(commit `441cea2`, `cli/src/commands/mnemoria/`); `main` has no mnemoria code and no
registration in `cli.ts`. On `main` the command map below stops after `run`. The four
`heretic-mnemoria*` skills are archived documentation for that branch.

## Synopsis

```
heretic-cli [-v|--version] [-V|--verbose] [--log-file <path>] <command> [args]
```

## Complete command map (verified from `--help`)

```
heretic-cli
├── init                                   Interactive global setup (tokens + agent profiles)
├── local-init [profile]                   Create per-profile local override (or --compose template)
│     --compose, -f/--force
├── local-validate [profile]               Validate .heretic/cli/ config(s), print resolved YAML
├── doctor [--fix]                         10 environment health checks
├── update                                 Check GitHub releases, stage new binary
├── ps [--json] [-s|--session <name>]      List heretic agent containers
├── stop [name] [--all] [-f] [--keep] [-s <name>]
├── attach <name> [-s|--session <name>]
├── agents
│     ├── list [--json]
│     ├── add <name> [--force]
│     ├── delete <name> [-f|--force]
│     ├── edit <name> [--editor]
│     ├── show <name> [--resolved] [--reveal]
│     ├── validate [name]
│     └── mcp <name> [--local] [--file <path>]
├── image
│     ├── build [tool flags…] [-n|-t|-r|-p|--no-cache|--dry-run|-a]
│     ├── build-sidecar <node|python|java|go|rust> [flags]
│     └── generate [--format dockerfile|entrypoint|ssh-exec|sidecar-exec|sidecar-dockerfile|exec-server]
├── mnemoria | mn  [-s|-p|-P|-j|--plain|--no-color|--ids]
│     ├── status
│     ├── config  (show | set | login | logout | profiles | use-palace | diagnose)
│     ├── palace  (create | list | show | update | delete)
│     ├── wing    (create | list | show | update | delete)
│     ├── room    (create | list | show | update | delete)
│     ├── store [content] | get <id> | list | delete <id>
│     ├── search [query]
│     ├── entity  (add | list | show | delete)
│     ├── triple  (add | list | delete)
│     ├── graph   (path | timeline | neighborhood)
│     ├── keyword (assign | get | search | list | delete)
│     ├── file    (upload | download | delete)
│     └── ingest [path] [status]
├── run <agent-name> [command…]            -d, -s, --mcp, --root, --sidecar, --builder-image, --disable-sidecars
└── <agent-name>                           implicit shortcut → `run <agent-name>`
```

## Global options — and the `-v` / `-V` trap

| Flag | Meaning |
| --- | --- |
| `-v`, `--version` | print version and `exit 0` |
| `-V`, `--verbose` | **verbose logging** (pino level `debug`) |
| `--log-file <path>` | tee all logs (level `trace`) to a file; parent dirs are created |
| `-h`, `--help` | help for the command/subcommand, `exit 0` |

`-v` is *version* and `-V` is *verbose* — the opposite of most CLIs. `-V` must appear
**before** the subcommand (`heretic-cli -V run claude`), because it is a program-level
option and the program uses `enablePositionalOptions()`.

## argv parsing: two non-obvious mechanisms

**1. `normalizeRunArgv()` (`cli/src/utils/run-argv.ts`, called from `cli/src/index.ts`).**
`run` uses Commander's `passThroughOptions()`, so anything after the agent name would belong
to the *container* command, and `run claude -s two --root` would silently run with session
`default` and command `-s two`. Before parsing, argv is rewritten for `run` only: the block of
known run options (from the Commander `run` definition, with their values; `--x=v` and `-sV`
forms included) directly after the agent name is moved in front of it. The custom command
starts at the first token that is not a known run option, so `run claude npm test -s x` keeps
`-s x` for npm. A bare `--root` anywhere before `--` is also hoisted (legacy behaviour).
Tokens after `--` are never touched: `heretic-cli run claude -- npm test --root` keeps
`--root` as an npm flag.

**2. `program.on("command:*")` — the bare-agent-name shortcut.** `heretic-cli claude` is
equivalent to `heretic-cli run claude`. This path does **not** go through Commander
option parsing; it hand-parses `process.argv.slice(3)`:

| Supported in shortcut form | Not supported |
| --- | --- |
| `-d` / `--detach` | `--mcp <value>` (silently ignored) |
| `-s` / `--session <name>` | anything positional before `--` |
| `--root`, `--disable-sidecars` | |
| `--sidecar <rt>` (repeatable), `--builder-image <rt>=<img>` (repeatable) | |
| custom command **only** after `--` | bare trailing command words |

So `heretic-cli claude npm test` does **not** run `npm test`; use
`heretic-cli claude -- npm test` or `heretic-cli run claude npm test`.

## Logging

- Always pino via `getLogger()`; never `console.log` — except `logRaw()` (a thin
  `console.log`) used for machine-facing output (tables, YAML, JSON).
- Initialized in a `preAction` hook, so `--verbose` affects everything downstream.
- **Compiled binary** (`process.argv` contains `$bunfs`): pino-pretty transports do not
  work, so a custom stream writes `LEVEL message` with ANSI colors to **stdout**.
- **Dev mode** (`bun run dev`): pino-pretty, `HH:MM:ss`, `hideObject` unless verbose.
- Because logs go to **stdout**, mixing them with `--json` output means you must filter.
  `agents list --json`, `ps --json`, and all `mnemoria --json` payloads are printed via
  `logRaw`, but info-level lines land on the same stream. Prefer `mnemoria -j` (which
  suppresses non-JSON lines through `emitLine`) or parse the last JSON block.

## Exit codes

| Code | Where |
| --- | --- |
| 0 | success; `--help` / `--version`; `doctor` with no failures |
| 1 | Commander errors (`exitOverride`), `doctor` with ≥1 `[fail]`, `local-validate` failure, most command errors, `agents validate` errors, `ps`/`stop`/`attach` fatal errors |
| *container exit code* | `run` in interactive mode sets `process.exitCode` to the container's own exit code |
| 2 | Mnemoria auth failure (`EXIT_AUTH`) |
| 3 | Mnemoria connection/timeout failure (`EXIT_CONNECTION`) |
| 130 | Mnemoria user cancellation at a confirm prompt (`EXIT_CANCELLED`) |
| 124 / 255 | *inside the container*: `sidecar-exec` timeout / server-side start failure |

## Every file heretic-cli touches

**Global (`~/.heretic/`, resolved by `HomeProfilePathProvider`)**

```
~/.heretic/
├── settings.yaml                  github.token / github.copilot_token (paths to scripts, or raw)
├── agents/<name>.yaml             agent profiles (one file per profile)
├── get-<name>-key.sh|.cmd         secret scripts created by `init` (0755 on Unix)
├── get-github-token-key.sh|.cmd   GitHub token script
├── get-copilot-token-key.sh|.cmd  Copilot token script
├── <name>-settings.json           Claude Code settings for that agent
└── mnemoria/
    ├── config.yaml                Mnemoria client config
    ├── auth.yaml                  OIDC tokens (chmod 0600)
    ├── auth-local.yaml            writable overlay when auth.yaml is read-only (containers)
    └── profiles/<name>.yaml       named connection profiles
```

**Per project (CWD)**

```
.heretic/
├── cli/
│   ├── <profile>.yaml             per-profile local override (preferred)
│   ├── agent.yaml                 legacy single local override (matched by `extends:`)
│   ├── compose.yaml               used verbatim by the `custom` runner (`local-init --compose`)
│   └── claude-settings.json       auto-detected, merged over the global settings at run time
└── temp/<session>/                session dir, chmod 0777, mounted into the container
    ├── .mcp.json                  generated MCP config
    ├── settings.json              merged Claude settings (visible as ~/.claude/settings.json)
    ├── .claude.json               seeded {"hasCompletedOnboarding": true}
    ├── compose.yaml               generated compose file (compose runner)
    └── entrypoint.sh              embedded entrypoint used by `run_as_root`
```

Also: `.heretic-cli.pending` next to the executable (staged self-update), and
`<exe>.backup` transiently while the update is applied.

## Container labels (the CLI's whole discovery mechanism)

| Label | Value |
| --- | --- |
| `heretic.managed` | `true` — every container/network the CLI creates |
| `heretic.agent` | profile name |
| `heretic.project` | absolute project dir (used to find "the container for this directory") |
| `heretic.session` | session name (default `default`) |
| `heretic.role` | `build-sidecar` on builder containers, `build-network` on the network |
| `heretic.runtime` | `node`/`python`/`java`/`go`/`rust` on builders |
| `heretic.network` | per-run sidecar network name (on both agent and builders) |

`ps` lists `heretic.managed=true` **minus** `heretic.role=build-sidecar`.
`stop` uses the same filter and additionally pulls in sibling sidecars.

## Development / build

All from `cli/`:

```bash
bun install
bun run dev -- <args>        # run from source
bun test                    # bun:test
bun run lint                # eslint (must be 0 errors)
bun run format              # prettier
bun run build               # native binary → dist/heretic-cli
bun run build:all           # linux x64/arm64, macos x64/arm64, windows
bun run bundle              # JS bundle for npm (dist/heretic-cli.js)
```

The user runs the **compiled** binary — source edits have no effect until `bun run build`.

## Things heretic-cli deliberately cannot do (don't invent them)

- No `logs`, `exec`, `restart`, `top`, `rm`, or `inspect` command — use `docker` directly
  (`docker logs heretic-<agent>-<session>-<hash>`). `attach` is the only session entry point.
- No `agents rename`, `agents copy`, or non-interactive `agents add` (the wizard always
  prompts; scripted creation means writing `~/.heretic/agents/<name>.yaml` yourself).
- No global `--json` — only `ps --json`, `agents list --json`, `agents show` (YAML), and
  the whole `mnemoria` group (`-j`).
- No `--dry-run` for `run`; the closest is `agents show <name> --resolved`.
- `update` cannot roll back to a chosen version (latest release only) and refuses to
  self-update npm/bun installs.
- No config file for the top-level CLI beyond `~/.heretic/settings.yaml` (github tokens
  only); everything else lives in profiles.
- No shell-completion generator, no `--no-color` outside the `mnemoria` group.
