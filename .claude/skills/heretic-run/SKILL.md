---
name: heretic-run
description: Complete reference for `heretic-cli run <agent> [command…]` and the bare-agent-name shortcut — every flag, the three runners (docker/compose/custom), exactly what is mounted, injected, generated and labelled, session semantics, interactive vs detached behavior, container naming, error paths and exit codes. Use when starting a containerized agent, passing a custom command, running as root, enabling sidecars for one run, overriding MCP config, or debugging why a container didn't start / had wrong env / wrong HOME.
---

# `heretic-cli run` — start an agent container

```
heretic-cli run <agent-name> [command...]
    -d, --detach                       run in background
    -s, --session <name>               session name (default: "default")
        --mcp <value>                  JSON string OR path to a .json file (array of servers)
        --root                         run container as root, keep HOME=/home/agent
        --sidecar <runtime>            repeatable: node|python|java|go|rust
        --builder-image <rt>=<image>   repeatable image override for a runtime
        --disable-sidecars             turn off all sidecars for this run

heretic-cli <agent-name> [-d] [-s <name>] [--root] [--sidecar rt] [--builder-image rt=img]
                         [--disable-sidecars] [-- <command...>]
```

Sources: `cli/src/commands/run-agent.ts`, `cli/src/runners/*`, `cli/src/utils/config-resolver.ts`.

## Pipeline

```
run-agent.ts
  1. build cliOverrides from flags  (mcp, extra.run_as_root, tool_backends)
  2. resolveConfig({ profileName, projectDir: cwd, cliOverrides, sessionName })
        global profile → local override → CLI overrides
        + ${VAR} interpolation, + secrets execution, + mcp_file merge
        + validateResolvedConfig()  → throws "Config validation failed: …"
  3. ensureSessionFree(): agent container heretic-<agent>-<session>-<hash8> already
     running/paused/restarting → "Agent '<a>' is already running in this folder in
     session '<s>' (<name>)." + hints, exit 1 (skipped for runner: custom; Docker
     lookup errors are ignored and left to the runner)
  3a. apply --builder-image to already-resolved sidecars (also profile-declared ones)
  4. reject sidecars + runner: custom
  5. createRunner(config) → DockerRunner | ComposeRunner | CustomRunner
  6. runner.start({ detach, command })
```

`run` prints `Resolving config for '<agent>'…`, `Using global profile: <agent>`,
`Starting agent '<agent>'…` at info level (local-override detection is logged at debug).

## Flags in detail

**`-d, --detach`** — starts and returns. Prints the container ID and
`Run 'heretic-cli attach <containerId>' to attach to this container`. For the compose
runner this becomes `docker compose up -d`.

**`-s, --session <name>`** — a per-project namespace. Affects:
`.heretic/temp/<session>/` (the agent's `~/.claude` or `~/.copilot`), the container name,
the `heretic.session` label, the compose project name, and the sidecar network name.
Two sessions of the same profile in the same directory can run simultaneously. A second run
of the *same* profile + session in the same directory is **refused** while the first is
running/paused/restarting (`ensureSessionFree` in `run-agent.ts`, exit 1, hints `-s <name>` /
`attach`); a *stopped* container of that session is still removed and recreated
(`removeExistingContainer`). Not checked for the custom runner. Session names are sanitized
with `[^a-zA-Z0-9_-] → -`.

**`command...`** — everything after the agent name replaces the profile's `command`
(container `Cmd`). `passThroughOptions()` keeps its flags intact:
`heretic-cli run claude npm test --watch` passes `--watch` to npm. In shortcut form you
must use `--`: `heretic-cli claude -- npm test --watch`.

**`--mcp <value>`** — if the value is an existing path it is read, else parsed as a JSON
string. It **must be a JSON array of server objects** (the `McpServer[]` shape), not the
`{"mcpServers":{…}}` map that `agents mcp` accepts:

```bash
heretic-cli run claude --mcp '[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/workspace"]}]'
heretic-cli run claude --mcp ./servers.json
```

Bad input → `Invalid --mcp value: MCP config must be a JSON array of server objects`,
exit 1. This override **replaces** the profile's `mcp` array. Not available in shortcut form.

**`--root`** — sets `extra.run_as_root: true` only when passed, so it never clobbers a
profile value. Effects: `User: root`, `HERETIC_RUN_AS_ROOT=1`, and the CLI's **embedded**
`entrypoint.sh` is written to `<session>/entrypoint.sh` (mode 0755) and bind-mounted over
`/entrypoint.sh:ro` so the flag works on images built before the feature existed. The
entrypoint's root block exports `HOME=/home/agent` and `USER=root`, keeping every
bind-mounted config resolvable.
Caveat: `docker exec` into that container shows `HOME=/root` because exec is a fresh login
that does not inherit the entrypoint's exports — PID 1 (your session shell) has
`HOME=/home/agent`.
`--root` is hoisted by `hoistRootFlag()` so it works before *or* after the agent name, but
never after a `--` separator.

**`--sidecar <rt>` / `--builder-image <rt>=<img>` / `--disable-sidecars`** — see
`heretic-sidecars`. Summary: `--sidecar` **replaces** the profile's sidecar list for this
run (default image `heretic-builder-<rt>:latest`); `--builder-image` retargets a runtime
(including profile-declared sidecars) and errors with
`--builder-image expects <runtime>=<image>, got '<raw>'`; `--disable-sidecars` wins over
`--sidecar` (it sets `tool_backends.sidecars: []`).

## Runner: `docker` (default, dockerode)

1. `docker.ping()` → `Docker is not available. Please ensure Docker is running.`
2. `ensureImage()` — lists local images, compares against `image` and `image:latest`,
   pulls if missing (progress at debug level). Failure →
   `Failed to pull image <image>: …`.
3. Start build sidecars first (network + builders + health gate) if configured.
4. `translateConfig()` → `ContainerCreateOptions`; remove any container with the same name.
5. `createContainer({...opts, name: heretic-<agent>-<session>-<hash8>})` where `hash8` is
   the first 8 hex chars of `sha256(projectDir)`.
6. **Detached**: `start()`, then `fixMountPermissions()`, return `{containerId, status:"running"}`.
   **Interactive**: `start()`, `fixMountPermissions()`, then spawn
   `docker attach <id>` with `stdio: "inherit"` and resolve with the container's real
   `State.ExitCode` after it closes.

`fixMountPermissions()` execs `chown -R agent:agent /home/agent/.claude /root/.claude`
(or the `.copilot` pair) as root inside the container — this is what makes Docker Desktop
bind mounts writable for uid 1000. Failures are logged at debug and ignored.

On any start failure the runner force-removes the container, cleans the temp MCP file, and
tears down the sidecars it created.

`docker attach` is used instead of dockerode's stream attach because it is more reliable
for interactive TTYs — which means the **`docker` CLI must be installed**, not just the
daemon socket.

## Runner: `compose`

Generates `<session>/compose.yaml` and shells out:
`docker compose -f <file> -p heretic-<agent>-<session>-<hash8> up [-d]` (`hash8` of the
project dir, so the same profile + session in two folders are separate compose projects).

- Requires `docker compose version` to succeed, else
  `docker compose v2 is not available. …`.
- Service `agent` carries image/working_dir/environment/volumes/labels/stdin_open/tty
  (+ command, network_mode, ports, cap_add, privileged, user, hostname, deploy limits,
  shm_size); `container_name` is the same `heretic-<agent>-<session>-<hash8>`.
- Your `compose.services` are merged in, then **heretic's builder services last** so
  heretic wins on a name collision. `compose.networks` and `compose.volumes` are emitted
  (top-level `volumes:` also collects sidecar `cache_volumes`).
- Project name is lowercased and `[^a-z0-9-] → -`.
- Cleanup handlers on `exit`, `SIGINT`, `SIGTERM` delete the temp compose file.
- `stop()` runs `docker compose down --volumes` — **this deletes named volumes**, including
  sidecar caches (the docker runner keeps them).
- `isRunning()` parses `docker compose ps --format json` and looks for service `agent`.
  Note this expects a JSON *array*; newer compose versions emit NDJSON, in which case the
  parse fails and `isRunning()` returns false.

## Runner: `custom`

Uses `.heretic/cli/compose.yaml` **verbatim** (create it with `heretic-cli local-init --compose`).
Nothing is generated or injected into the file; instead the resolved `secrets` + `env` (plus
GitHub/Copilot tokens) are exported into the `docker compose` **process environment** for
`${VAR}` interpolation inside your compose file. Project name is `heretic-<agent>` (no
session). Missing file → constructor throws
`Custom compose file not found: … The custom runner requires a .heretic/cli/compose.yaml file in your project directory.`
Build sidecars are rejected for this runner:
`Build sidecars require the 'docker' or 'compose' runner, but this profile uses the custom runner.`
`attach`/`ps -q` target the **first** service reported by compose, not necessarily `agent`.

## What lands in the container (docker & compose)

Env: resolved secrets (docker: only those also named in `env`) → `env` → transformations
(`ANTHROPIC_API_KEY` split, empty-value stripping with the intentional-`""` exception) →
GitHub/Copilot tokens → `git.*` → `HERETIC_RUN_AS_ROOT` → `BUILD_SIDECARS` /
`SIDECAR_ENV_PASSTHROUGH` → `SSH_*`.
Env **names** are logged at info level; values only at debug and masked to 4 chars.

Mounts: profile `volumes` → `<session>/entrypoint.sh` (root mode) → ssh key → generated
`.mcp.json` (both copilot paths, or `/workspace/.mcp.json`) → docker socket (dind) →
session dir as `~/.claude`/`~/.copilot` (both `/home/agent` and `/root`) → `.claude.json`.

Labels: `heretic.managed=true`, `heretic.agent`, `heretic.project`, `heretic.session`,
`heretic.network` (when sidecars), plus `extra.labels` last (so they can override).

## Examples

```bash
heretic-cli run claude                        # interactive, session "default"
heretic-cli claude                            # identical (shortcut)
heretic-cli run claude -s feature-x           # separate session/home/container
heretic-cli run claude -d && heretic-cli ps   # background, then list
heretic-cli run claude -- bash -lc 'npm ci && npm test'
heretic-cli run claude --root                 # root, HOME=/home/agent
heretic-cli run claude --sidecar node --sidecar python
heretic-cli run claude --builder-image node=ghcr.io/me/builder-node:1.2.3
heretic-cli run claude --disable-sidecars
heretic-cli run claude --mcp ./mcp-servers.json
heretic-cli -V run claude                     # verbose (flag must precede the subcommand)
```

## Errors and exit codes

| Situation | Output | Exit |
| --- | --- | --- |
| unknown profile | `Profile '<x>' not found.` + `Run 'heretic-cli agents list' …` | 1 |
| invalid profile YAML/shape | `Invalid profile '<x>': …` | 1 |
| local override for another profile | `Local config extends 'a' but loading profile 'b'` | 1 |
| all-comment local override (fresh `local-init`) | `Failed to load local config from …: Invalid config: expected an object` | 1 |
| post-merge validation | `Config validation failed: <joined errors>` | 1 |
| Docker down | `Docker is not available. Start Docker and try again.` | 1 |
| bad `--mcp` | `Invalid --mcp value: …` | 1 |
| bad `--builder-image` | `--builder-image expects <runtime>=<image>, got '…'` | 1 |
| sidecars + custom runner | see above | 1 |
| sidecar never healthy | `build sidecar '<name>' did not become healthy within <n>s` | 1 |
| container ran | `Container exited with code <n>` (info, only when ≠ 0) | **container's code** |

## Gotchas

- **`run` never merges a local override's volumes** — the array is replaced wholesale.
- A profile whose `volumes` do not include an absolute source fails validation *before*
  Docker is touched; `${CWD}`/`${HOME}` are your friends.
- Interactive mode requires a TTY for a useful session; in CI use `-d` plus
  `docker logs`, or pass an explicit command.
- The session dir is created `0777` (`ensureSessionDir`) so arbitrary container uids can
  write. Treat it as ephemeral scratch — `.mcp.json`, `settings.json`, `compose.yaml`, and
  `entrypoint.sh` are regenerated per run.
- `--session` does **not** isolate the workspace mount; both sessions edit the same files.
- Detached compose runs leave the generated compose file in place only until the process
  exits (cleanup handlers delete it) — `heretic-cli stop` uses labels, not the file, so
  this is fine.
- There is no `run --dry-run`; use `heretic-cli agents show <x> --resolved` or
  `heretic-cli local-validate <x>`.
