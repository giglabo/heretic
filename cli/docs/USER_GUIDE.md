# Heretic CLI — User Guide

This guide documents end-user features of `heretic-cli`. It currently covers
**sessions** (several agents in one folder), **publishing ports** and **tool execution backends**
(the build-sidecar and SSH backends). Additional sections will be added as features are documented.

---

## Sessions: several agents in one folder

Every `heretic-cli run` belongs to a **session** (`-s, --session <name>`, default `default`).
A running agent is identified by *profile + session + project folder*; its container is named
`heretic-<profile>-<session>-<hash8>`, where `<hash8>` is derived from the absolute folder path.

To run two agents with the **same profile in the same folder**, give each its own session:

```bash
cd ~/my-project
heretic-cli run myagent -s a      # terminal 1 (or: heretic-cli myagent -s a)
heretic-cli run myagent -s b      # terminal 2
```

Each session gets its own container, its own `.heretic/temp/<session>/` directory (mounted as
`~/.claude` / `~/.copilot`, so chat history, settings, `.claude.json` and generated MCP config are
separate), and its own build-sidecar network and builder containers.

If you start the same profile + session again while that session is still **running** (or paused),
`run` refuses and exits with code 1 instead of replacing the live container:

```
Agent 'myagent' is already running in this folder in session 'default' (heretic-myagent-default-1a2b3c4d).
Run another one in a separate session: heretic-cli run myagent -s <name>
Or attach to it: heretic-cli attach myagent -s default
```

A **stopped** container of the same session is removed and recreated, as before. The same profile
and session in two *different* folders never collide (the folder hash is part of every name,
including the compose runner's project name). The check does not apply to the `custom` runner,
whose container names come from your own compose file.

What sessions do **not** separate:

- **The workspace.** Both agents mount the same folder and the same git working tree. For
  independent tasks, a `git worktree add ../my-project-b` gives the second agent its own folder
  (then it doesn't need a separate session at all).
- **Explicit ports.** A port listed in `extra.ports` can be published only once; the second agent
  fails with Docker's "port is already allocated". Use `--no-ports` or `--port-offset <n>` for it.
  Preset ports that are already taken are skipped automatically (see below).

Manage sessions with `heretic-cli ps` (shows the session), `heretic-cli attach <profile> -s <session>`
and `heretic-cli stop -s <session>`.

---

## Publishing Ports

Dev servers inside the agent container (Vite, Next.js, Astro, an API…) are
reachable from the host only through published ports. Declare them in the
profile or the local override (`.heretic/cli/<profile>.yaml`), or add them for
one run on the command line.

### Port specs

Same syntax as `docker run -p`; single ports, ranges and remaps:

| Spec | Publishes |
| --- | --- |
| `3000` | host 3000 → container 3000 |
| `3000-3020` | host 3000–3020 → container 3000–3020 |
| `13000-13020:3000-3020` | remapped range (both sides must be the same length) |
| `15432:5432` | remapped single port |
| `127.0.0.1:8080:8080` | only on one host interface |
| `[::1]:8080:8080` | IPv6 host interface |
| `127.0.0.1::8080` | random free host port (see `docker port <container>`) |
| `5353/udp` | UDP (`tcp` is the default, `sctp` also works) |

Without a host IP Docker binds all interfaces (`0.0.0.0` and `::`), so the
ports are reachable from the host and the LAN. Dev servers inside the container
must listen on `0.0.0.0` too, not `localhost` (`vite --host`, `astro dev --host`,
`next dev -H 0.0.0.0`).

### Presets

Named sets of typical development ports. List them with `heretic-cli port-presets`.

| Preset | Ports |
| --- | --- |
| `web` | 3000-3020, 4000-4010, 4173-4180 (Vite preview), 4200-4210 (Angular), 4321-4330 (Astro), 5000-5010, 5173-5190 (Vite), 6006-6010 (Storybook), 8000-8020, 8080-8100, 8443, 8888-8890 (Jupyter), 9000-9010, 19000-19006 (Expo), 1313, 1420-1421, 3333, 4983, 5555, 24678, 35729 |
| `debug` | 9229-9239 (Node inspector), 9222, 5005 (JDWP), 5678 (debugpy), 2345 (Delve) |
| `db` | 5432-5433, 3306, 6379, 27017, 5672, 15672, 7700, 8123, 9200 |
| `supabase` | 54320-54330 |
| `mail` | 1025, 8025 |
| `dev` | `web` + `debug` |
| `all` | every preset above |

Preset ports that are **already in use on the host** (a local database, another
agent container with the same preset) are skipped with a warning instead of
failing the start. Explicit `ports` entries are never skipped; a conflict there
fails the start, as with `docker run -p`.

With `dind: true`, containers the agent starts via the host Docker socket
(`supabase start`, `docker compose up`) publish their own ports on the host. Do
not put those ports (e.g. the `db` and `supabase` presets) on the agent too: the
agent would take the host port first and the sibling would fail to start. From
inside the agent, reach such services at `host.docker.internal:<port>`.

### Profile fields

```yaml
extra:
  port_presets: [dev]           # presets to publish
  ports:                        # explicit specs; win over presets
    - "15432:5432"              # remap one port a preset brought in
    - "13000-13020:3000-3020"
  ports_host_ip: 0.0.0.0        # bind IP for specs without one (default: all interfaces)
  ports_offset: 10000           # shift host ports of presets and same-port specs
```

- **One host binding per container port.** An explicit spec replaces the preset
  entry for the same container port, so remapping a single port of a preset is
  just adding `"<host>:<container>"`.
- **`ports_offset`** shifts every spec without an explicit host port, presets
  included: with `10000`, container 3000 is published as host 13000. Use it to
  run a second agent next to the first without collisions.
- **Layers.** `ports` and `port_presets` in a local override replace the global
  profile's lists; the scalars override. On the command line `--port` and
  `--port-preset` **add** to whatever the profile has.

### Command line

```bash
heretic-cli run default --port-preset dev                  # typical dev ports
heretic-cli run default -p 3000-3020 -p 15432:5432         # ranges and remaps
heretic-cli run default --port-preset dev --port-offset 10000  # second agent side by side
heretic-cli run default --port-host-ip 127.0.0.1           # only this machine
heretic-cli run default --no-ports                         # ignore the profile's ports
heretic-cli port-presets                                   # list presets
```

Ports are bound when the container is created: after changing them, stop and
start the agent again.

**Cost.** Docker runs a small proxy process per published port and address
family, so `all` (~200 ports) means ~400 `docker-proxy` processes on Linux.
Prefer `dev` or specific presets.

---

## Tool Execution Backends

By default, an agent container runs build and test commands (`npm install`,
`pytest`, `mvn package`, `go build`, `cargo test`, …) inside itself, using
whatever toolchains are baked into the agent image. **Tool execution backends**
let you run those commands somewhere else instead — in a dedicated *build
sidecar* container, or on a remote host over SSH — while the agent keeps editing
files in the shared workspace.

There are two backends:

| Backend | You configure | Commands run in | Best for |
|---------|---------------|-----------------|----------|
| **Build sidecar** (HTTP) | `tool_backends.sidecars` | a sibling container per runtime, sharing your project dir | keeping the agent image small; isolating heavy toolchains |
| **SSH** | top-level `ssh:` block | a remote host / the Docker host | using an existing remote toolchain |

Both work by the same mechanism inside the container: at start-up the agent's
entrypoint generates thin wrapper scripts on `PATH` (`/opt/sidecar/wrappers/*`)
for known commands. When a wrapped command runs, it forwards the command to the
backend instead of executing locally.

> **The local binary always wins.** A wrapper is only generated for a command
> that the agent image does **not** already provide. If your agent image ships
> Node, `npm` runs locally and is never routed to a sidecar.

### Quick start (build sidecar)

1. **Have a builder image.** A builder image runs an `exec-server` on a port
   (default 8080) and contains the runtime's toolchain (e.g. Node + npm/pnpm/yarn).
   The quickest way is to build one with heretic:

   ```bash
   heretic-cli image build-sidecar node     # -> heretic-builder-node:latest
   ```

   You can also point at any image you already have that runs a compatible
   `exec-server` — this is the *bring-your-own builder* on-ramp. See
   [Building builder images](#building-builder-images) below.

2. **Add a `tool_backends` block to your profile** (`~/.heretic/agents/<name>.yaml`):

   ```yaml
   image: heretic-agent:latest
   runner: docker             # docker or compose — both orchestrate sidecars
   volumes:
     - source: ${CWD}
       target: /workspace     # the shared bind
   workdir: /workspace
   tool_backends:
     sidecars:
       - runtime: node
         image: heretic-builder-node:latest
       - runtime: python
         image: heretic-builder-python:latest
   ```

3. **Run it.** `heretic-cli run <name>` starts the builder(s), waits until each is
   healthy, then starts the agent. Inside the agent, `npm`, `pip`, `pytest`, …
   transparently execute in the matching builder against the same `/workspace`.

Or skip the profile and enable sidecars ad hoc for one run:

```bash
# Enable node + python sidecars (default image heretic-builder-<runtime>:latest)
heretic-cli run myagent --sidecar node --sidecar python

# Point a runtime at a specific builder image
heretic-cli run myagent --sidecar node --builder-image node=ghcr.io/acme/node-builder:20

# Turn off sidecars a profile declares, for this run only
heretic-cli run myagent --disable-sidecars
```

`--sidecar` **replaces** the profile's sidecar list for that run. `--builder-image`
also overrides the image of a sidecar the profile already declares.

Both the **`docker`** and **`compose`** runners orchestrate sidecars. The
`docker` runner does it natively with the Docker API: it creates a private
per-run network, starts each builder, waits until it is healthy, then starts the
agent joined to that network. The `compose` runner does the same via a generated
`docker-compose.yaml`. Only the `custom` runner can't manage siblings — a profile
that pins `runner: custom` with sidecars is rejected.

`heretic-cli stop` tears down the agent **and** its build sidecars together
(and removes the per-run network); `heretic-cli ps` lists agents only, not the
builder infrastructure.

### Profile reference: `tool_backends`

```yaml
tool_backends:
  workspace_target: /workspace   # shared mount target; must match a volume target (default "/workspace")
  ready_timeout: 60              # seconds to wait for each sidecar to become healthy (default 60)
  run_as_caller_uid: true        # run builders as your uid:gid so build output isn't root-owned (default true)
  sidecars:
    - runtime: node              # REQUIRED — one of: node | python | java | go | rust
      image: heretic-builder-node:latest   # REQUIRED — builder image
      port: 8080                 # exec-server port inside the builder (default 8080)
      command: ["exec-server", "-port", "8080", "-cwd", "/workspace"]  # override if your image differs
      env:                       # env vars set in the builder
        NX_DAEMON: "false"
      env_passthrough: [NPM_TOKEN, PIP_INDEX_URL]   # env var names forwarded per command
      cache_volumes:             # named volumes for warm caches
        - heretic-cache-node:/home/agent/.npm
```

**Field notes**

- **`runtime`** must be one of the five known keys. Any other value is rejected
  at validation time (the agent side only knows how to route these five).
- **`workspace_target`** must match one of your `volumes` targets — the builders
  bind-mount the **same host path** so the agent and builders see one filesystem.
  If no volume targets it, the run fails with a clear error.
- **`env_passthrough`** is an *allowlist* of env var names forwarded from the
  agent into each build command. Only listed names are forwarded — the agent's
  secrets (API keys, tokens) are never sent to a builder unless you name them.
- **`run_as_caller_uid`** (default `true`) makes build artefacts (`node_modules/`,
  `target/`, …) owned by you rather than root. On Windows, where a caller uid is
  not available, builders fall back to `1000:1000`.

### What gets created

For the profile above, one `builder-<runtime>` container is created per sidecar,
alongside the agent, all sharing `${CWD}:/workspace` on a private per-run network
(the `compose` runner expresses the same thing as services in a generated
`docker-compose.yaml`):

- the agent receives
  `BUILD_SIDECARS={"node":{"internal_url":"http://builder-node:8080"},"python":{"internal_url":"http://builder-python:8080"}}`;
- each builder is health-gated, so the agent only starts once the sidecars answer
  `/health` (compose uses `depends_on … condition: service_healthy`; the docker
  runner polls the builder's health before starting the agent);
- builders run with `cap_drop: [ALL]` and `no-new-privileges`, publish **no
  ports**, and are reachable only by their `builder-<runtime>` name on the
  private network.

### Limitations (read before relying on it)

- **Only ~25 commands are routed.** The wrapped set is: `npm npx pnpm yarn node`
  (node); `python python3 pip pip3 poetry pytest ruff black mypy` (python);
  `java javac mvn gradle` (java); `go gofmt` (go); `cargo rustc rustfmt clippy`
  (rust). Commands like `make`, `tsc`, `jest`, `./node_modules/.bin/*`, `uv`, and
  `bun` are **not** wrapped and run locally in the agent container.
- **No interactivity.** The HTTP sidecar cannot do stdin, a TTY, REPLs, watch
  modes, or Ctrl-C. Route only non-interactive, CI-shaped commands (install /
  build / test / lint / format).
- **One backend per project.** Configuring both a sidecar and the `ssh:` backend
  makes a single build span two different filesystems; heretic warns when it sees
  both. Pick one.
- **Cache volumes and teardown.** `heretic-cli stop` runs `docker compose down
  --volumes`, which currently also removes named cache volumes. Persistent caches
  across `stop`/`start` are a planned follow-up.

### Building builder images

`heretic-cli image build-sidecar <runtime>` builds a builder image for one of the
five runtimes. Each image is a small multi-stage build: a static Go `exec-server`
compiled from heretic's vendored source, dropped onto the runtime's toolchain base.

```bash
# Build the default node builder -> heretic-builder-node:latest
heretic-cli image build-sidecar node

# Pin the toolchain version and push to a registry
heretic-cli image build-sidecar python --runtime-version 3.12 \
  --registry ghcr.io/acme --push

# Multi-arch, custom name/tag
heretic-cli image build-sidecar go --arch both -n my-go-builder -t v1

# Preview the generated Dockerfile without building
heretic-cli image build-sidecar rust --dry-run
```

| Option | Meaning |
|--------|---------|
| `<runtime>` | `node` \| `python` \| `java` \| `go` \| `rust` (required) |
| `-n, --name` | image name (default `heretic-builder-<runtime>`) |
| `-t, --tag` | image tag (default `latest`) |
| `-r, --registry` | registry prefix (e.g. `ghcr.io/acme`) |
| `--runtime-version` | toolchain version (e.g. node `22`, python `3.13`, java `21`) |
| `--go-builder` | Golang image for the exec-server build stage (default `golang:1.23-bookworm`) |
| `--port` | exec-server port baked into the image (default `8080`) |
| `-p, --push` | push after build; `--arch both` for multi-arch (buildx) |
| `--no-cache` / `--dry-run` | rebuild from scratch / print the Dockerfile and exit |

Each builder ships as a **non-root** user, exposes only the exec-server port on the
compose network, and carries a **port-agnostic** healthcheck. What lands in each:

| Runtime | Base | Toolchain |
|---------|------|-----------|
| `node` | `node:<v>-bookworm-slim` | node, npm, npx, yarn, pnpm |
| `python` | `python:<v>-slim-bookworm` | python, pip, poetry, pytest, ruff, black, mypy |
| `java` | `eclipse-temurin:<v>-jdk` | java, javac, mvn, gradle |
| `go` | `golang:<v>-bookworm` | go, gofmt |
| `rust` | `rust:<v>-bookworm` | cargo, rustc, rustfmt, clippy |

To inspect or vendor the artefacts without building, use `image generate`:

```bash
heretic-cli image generate --format sidecar-dockerfile --runtime node
heretic-cli image generate --format exec-server        # the Go server source
```

**Bring your own:** any image that runs a compatible `exec-server` works. The
wire contract is small — `GET /health`, `GET /info`, `POST /exec` (blocking JSON),
`POST /exec/stream` (SSE). Point `image:` at it and skip `build-sidecar` entirely.

### SSH backend (alternative)

The SSH backend routes wrapped commands to `ssh user@host "cd <cwd> && <cmd>"`.
It is configured with a top-level `ssh:` block and needs no builder images:

```yaml
ssh:
  host: build-host.internal
  port: 22
  user: builder
  key_path: /home/me/.ssh/id_build   # absolute path; mounted read-only
  host_cwd: /srv/workspace           # working dir on the remote
```

The defining caveat: unless the remote path is the *same* filesystem the agent
edits, the build runs against a different tree than the one you're changing. Use
it when the remote host already has the toolchain you want.
