---
name: heretic-lifecycle
description: Complete reference for heretic-cli container lifecycle commands `ps`, `stop`, and `attach` — label-based discovery, session filtering, container naming, JSON output shape, sidecar sibling teardown and network cleanup, name/ID prefix matching rules, and detach keystrokes. Use when listing/stopping/attaching to running heretic agent containers, cleaning up build sidecars or per-run networks, or debugging "No heretic container found" messages.
---

# `ps` / `stop` / `attach` — container lifecycle

All three discover containers purely by **labels** (never by name pattern), so they only
ever see containers heretic created. Sources: `cli/src/commands/{ps,stop,attach}.ts`,
`cli/src/runners/sidecar-manager.ts`.

Container name format: `heretic-<agent>-<session>-<hash8>` where `hash8` =
first 8 hex chars of `sha256(<absolute project dir>)`, agent sanitized `[^a-zA-Z0-9_-]→-`,
session sanitized the same way.

## `heretic-cli ps`

```
heretic-cli ps [--json] [-s|--session <name>]
```

Filters `heretic.managed=true` (+ `heretic.session=<name>` with `-s`), lists **all** states
(`all: true`), then **removes** containers labelled `heretic.role=build-sidecar` — builders
are infrastructure, not agents (they stay discoverable by label for cleanup).

```
$ heretic-cli ps
NAME                                AGENT   SESSION  STATUS   UPTIME  PORTS
heretic-claude-default-1a2b3c4d      claude  default  running  4m ago  3000→3000
heretic-claude-feat-x-1a2b3c4d       claude  feat-x   exited   2h ago  -
```

| Column | Source |
| --- | --- |
| NAME | `Names[0]` minus the leading `/`, else 12-char ID |
| AGENT | label `heretic.agent`, else `unknown` |
| SESSION | label `heretic.session`, else `-` |
| STATUS | Docker `State` (`running`, `exited`, `created`, `paused`, `dead`) |
| UPTIME | **relative time since `Created`**, not since start — `s/m/h/d ago` |
| PORTS | published mappings `public→private`, else `-` |

`--json` prints the same fields as an array of objects (`name, agent, session, status,
uptime, ports`) — `uptime`/`ports` are pre-formatted strings, not numbers.

No containers → `No running heretic agents.` (or `[]`). Docker unreachable →
`Docker is not running or not available`, **exit 1**.

## `heretic-cli stop`

```
heretic-cli stop [name] [--all] [-f|--force] [--keep] [-s|--session <name>]
```

Target selection (label filter `heretic.managed=true` [+ session]):

1. `--all` → **every** heretic container, agents *and* sidecars.
2. `[name]` → matched against **agent containers only** (sidecars can never be mistaken for
   the agent), then its sibling sidecars are added.
3. no argument → the agent container whose `heretic.project` equals `process.cwd()`
   (plus `heretic.session` when `-s` is given), then its siblings.

Name matching (`findContainerByNameOrId`, first match wins):
container ID **starts with** the string, or a container name equals it, **or a container
name contains it as a substring**. So `stop claude` matches
`heretic-claude-default-1a2b…`; ambiguous substrings pick an arbitrary first match.

Sibling sidecars = containers with `heretic.role=build-sidecar`, the same
`heretic.project`, and (when the agent has one) the same `heretic.session`.

Then, unless `--force`:

```
Stop 3 container(s): heretic-claude-default-1a2b3c4d, heretic-builder-node-default-1a2b3c4d, … ? (use --force to skip) (Y/n)
```

Default is **yes** (unlike `agents delete`, whose default is no). Declining prints `Aborted`.

Per container: already `exited`/`dead` → `Container X is already stopped`; otherwise
`docker stop` with a 10 s timeout → `Stopped X`. Unless `--keep`, then `docker rm` →
`Removed X`. Failures are collected and reported at the end
(`Errors occurred while stopping containers:` → exit 1) — one failure never aborts the rest.

**Network cleanup**: unless `--keep`, every distinct `heretic.network` label value among the
stopped containers is removed (`removeNetworkByName`, tolerant of "in use"/"not found").
**Named cache volumes are intentionally preserved** so builder caches stay warm across
runs — that is the docker-runner path. (The compose runner's own `stop()` uses
`docker compose down --volumes`, which *does* delete them; `heretic-cli stop` does not go
through that path.)

```bash
heretic-cli stop                    # the container for this directory (+ its sidecars)
heretic-cli stop -f                 # …no prompt
heretic-cli stop claude --keep      # stop but keep containers and network
heretic-cli stop --all -f           # everything heretic-managed
heretic-cli stop -s feat-x -f       # only session feat-x
```

Messages: `No heretic containers found` (nothing matched the label filter),
`No heretic container found matching '<name>'`, `No heretic container found for the current
directory` — all exit 0 (they are not errors).

## `heretic-cli attach`

```
heretic-cli attach <name> [-s|--session <name>]
```

Requires the container to be **running**; otherwise
`Container '<name>' is not running (state: <state>)` → exit 1. Uses the same
name/ID-prefix/substring matching as `stop` but over **all** heretic containers (sidecars
included — attaching to a builder just shows the exec-server's output).

```
$ heretic-cli attach claude
Attached to heretic-claude-default-1a2b3c4d. Press Ctrl+P, Ctrl+Q to detach.
```

Implementation: `spawn("docker", ["attach", <id>], { stdio: "inherit" })`, so the **docker
CLI must be on PATH** and the process exits with `docker attach`'s exit code.
`Ctrl+P, Ctrl+Q` detaches without killing; `Ctrl+C` forwards SIGINT to the container's PID 1
(usually killing the session).

Attaching to a container started **without** `interactive: true` gives you output but no
stdin. For a second independent shell, use `docker exec -it <name> bash` — but remember a
fresh exec does not inherit the entrypoint's `HOME` export under `--root`.

## Cheat sheet: cleaning up completely

```bash
heretic-cli ps                                  # what's alive (agents only)
docker ps -a --filter label=heretic.managed=true    # agents AND sidecars
heretic-cli stop --all -f                       # stop+remove all, drop per-run networks
docker network ls --filter label=heretic.role=build-network
docker volume ls                                # cache volumes are never auto-removed
```

## Gotchas

- **UPTIME is age, not uptime.** A container created two days ago and restarted a minute
  ago still shows `2d ago`.
- `ps` hides sidecars; if a build hangs, inspect them with
  `docker ps --filter label=heretic.role=build-sidecar` and
  `docker logs heretic-builder-<rt>-<session>-<hash8>`.
- `stop` with no argument keys off `heretic.project == process.cwd()` — an exact string
  match. Running it from a subdirectory or through a symlinked path finds nothing.
- There is no `heretic-cli logs` / `restart` / `rm`; use docker directly.
- `--keep` also skips network removal, so a kept container stays attached to its
  `heretic-net-…` network.
- `stop` never prunes `.heretic/temp/<session>/` — session state (including
  `~/.claude` history) survives on purpose.
