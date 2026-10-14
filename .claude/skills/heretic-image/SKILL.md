---
name: heretic-image
description: Complete reference for `heretic-cli image build` and `image generate` — every tool/version flag, agent types and combined mode, image naming and registry/push/arch (buildx) behavior, the generated Dockerfile stage by stage, the baked ENTRYPOINT and its interactive vs workflow modes, all runtime env vars, and the template generators. Use when building Heretic agent Docker images, previewing/generating a Dockerfile or entrypoint, choosing toolchains or base images, or debugging image build/agent-CLI-not-found problems.
---

# `heretic-cli image` — build agent images

```
heretic-cli image build         [agent+tool flags] [-n|-t|-r|-p|--no-cache|--dry-run|-a]
heretic-cli image build-sidecar <runtime> [...]        → see the heretic-sidecars skill
heretic-cli image generate      [--format …] [same tool flags]
```

Sources: `cli/src/commands/image.ts`, `cli/src/templates/{types,dockerfile,entrypoint,resources}.ts`,
`cli/src/templates/assets/{Dockerfile.hbs,entrypoint.sh,sidecar-exec,ssh-exec}`.

Everything is generated in memory into a temp dir (`mkdtemp heretic-build-`), built with the
`docker` CLI, and the temp dir is removed in a `finally` block. Assets are embedded in the
binary via Bun text imports, so no files need to ship alongside the executable.

## Agent types and naming

`--agent <type>` is repeatable; `all` expands to every type. Values and what they install:

| `--agent` | npm packages |
| --- | --- |
| `claude` (default) | `@anthropic-ai/claude-code`, `mcp-remote` |
| `copilot` | `@github/copilot` |
| `opencode` | `opencode-ai` |
| `gemini` | `@google/gemini-cli`, `mcp-remote` |

Invalid value → `Invalid agent type '<x>'. Use: claude, copilot, opencode, gemini, or all`.
Duplicates are removed and the list is sorted.

Image naming (`fullImageName`):

- one agent, `claude` → `<name>:<tag>` (default `heretic-agent:latest`)
- one agent, non-claude → `<name>-<agent>:<tag>` (e.g. `heretic-agent-gemini:latest`)
- `--combined` with >1 agent → a **single** image named `<name>:<tag>` containing all CLIs
- `--registry <reg>` prefixes everything: `<reg>/<name>:<tag>`

Multiple agents **without** `--combined` builds them sequentially, one image each, and
prints the list at the end. With `--combined`, `AGENT_TYPE` build-arg is set to `combined`
and the usage hint shows `docker run -it --rm -e AGENT_TYPE=<agent> <image>` per agent.

## Tool flags (shared by `build` and `generate`)

| Flag | Effect | Default |
| --- | --- | --- |
| `--base <image>` | base image | `node:22-bookworm-slim` |
| `--with-python`, `--python-version <ver>` | Python + pip, poetry, pytest, black, ruff, mypy | off, `3.13` |
| `--with-node`, `--node-version <ver>` | Node.js via NodeSource + corepack | auto, `22` |
| `--with-go`, `--go-version <ver>` | Go tarball from go.dev + PATH | off, `1.23.4` |
| `--with-java`, `--java-version <ver>` | Temurin JDK + Maven 3.9.6 + Gradle 8.5 | off, `21` |
| `--with-rust`, `--rust-version <ver>` | rustup + rustfmt + clippy | off, `stable` |
| `--with-docker` | Docker CLI + compose plugin (DinD/DooD) | off |
| `--with-github-cli` / `--no-github-cli` | GitHub CLI (`gh`) | **on** |
| `--with-all` | python+node+go+java+rust+docker+github-cli | off |
| `--agent-user`, `--agent-uid`, `--agent-gid` | container user | `agent`, `1000`, `1000` |

Passing a `--*-version` flag **implies** the corresponding `--with-*`. Node is special: when
the base image starts with `node:` corepack is simply enabled ("included in base"); otherwise
Node is installed unconditionally because the agent CLIs need it ("auto (required for CLIs)").
`--base ubuntu:*` additionally installs and generates `en_US.UTF-8` locales.

## Build-only flags

| Flag | Meaning |
| --- | --- |
| `-n, --name <name>` | image name (default `heretic-agent`) |
| `-t, --tag <tag>` | tag (default `latest`) |
| `-r, --registry <reg>` | registry prefix, e.g. `ghcr.io/me` |
| `-p, --push` | push after build |
| `--no-cache` | `docker build --no-cache` |
| `--dry-run` | print the Dockerfile **and** the entrypoint, build nothing (skips the Docker availability check) |
| `-a, --arch <arch>` | `amd64`/`x86_64`, `arm64`/`aarch64`, `both`/`all`; anything else = current platform |

Build mode selection:

| Condition | Command |
| --- | --- |
| no `--arch` | `docker build --build-arg … --tag … -f Dockerfile .` (then `docker push` if `-p` **and** `-r`) |
| `--arch` set, no `-p` | `docker buildx build … --platform <p> --load …` ("Mode: buildx local") |
| `--arch` set + `-p` | `docker buildx build … --platform <p> --push …` ("Mode: buildx with push") |

Note: a plain `docker build` with `-p` but **no `-r`** never pushes (the registry check
guards it). `--arch both` + `--load` is not supported by buildx for multi-platform images —
use `--push` for multi-arch.

Build args always passed: `BASE_IMAGE`, `AGENT_USER`, `AGENT_UID`, `AGENT_GID`, `AGENT_TYPE`.

Pre-flight: unless `--dry-run`, Docker must be reachable, else
`Docker is not available. Install Docker or use --dry-run to preview the Dockerfile.` → exit 1.

## The generated Dockerfile (order matters)

1. `ARG BASE_IMAGE` → `FROM ${BASE_IMAGE}`; args `TARGETARCH`, `AGENT_USER/UID/GID`, `AGENT_TYPE`;
   OCI labels; `ENV DEBIAN_FRONTEND`, `PYTHONUNBUFFERED`, `PIP_*`, `AGENT_TYPE`.
2. Base packages: `ca-certificates curl git jq xz-utils gnupg unzip openssh-client vim`.
   (`jq` and `curl` are **required** by `sidecar-exec`; `openssh-client` by `ssh-exec`.)
3. Optional locales (ubuntu base), corepack or NodeSource Node, then each `--with-*` block.
4. `RUN npm install -g <agent packages>`.
5. **Tool backends**: `COPY sidecar-exec /opt/sidecar/sidecar-exec`,
   `COPY ssh-exec /opt/sidecar/ssh-exec`, `chmod +x`, `mkdir -p /opt/sidecar/wrappers`,
   `chown ${AGENT_UID}:${AGENT_GID} /opt/sidecar/wrappers`, and
   `ENV PATH="/opt/sidecar/wrappers:${PATH}"` — the wrappers dir must be writable by the
   agent user because the entrypoint writes wrappers there at start-up.
6. Create the agent user (`userdel -r node` first, since `node:*` bases ship uid 1000),
   copy the Rust toolchain into its home when `--with-rust`.
7. `mkdir -p <agent dirs>` + `chown -R` (`~/.claude`, `~/.config/opencode`, `~/.gemini`,
   `/workspace`, per agent type; all of them in combined mode).
8. `COPY entrypoint.sh /entrypoint.sh`, `chmod +x`, **`ENTRYPOINT ["/entrypoint.sh"]`**.
9. `USER ${AGENT_USER}`, `WORKDIR /home/${AGENT_USER}`.
10. Runtime env defaults: `API_TIMEOUT_MS=3000000`, `GH_TOKEN=""`, `TASK_ID=""`,
    `STEP_NAME=""`, `REPO_PATH=/workspace`, `PROMPT_FILE=""`, `AGENT_ARGS=""`,
    `AGENT_OUTPUT_FORMAT=stream-json`.
11. `CMD ["/bin/bash"]` — the default argv the entrypoint `exec`s.

Baking `ENTRYPOINT` is what makes the tool backends work at all: without it the wrappers are
never generated.

## The baked entrypoint

`/entrypoint.sh` does three things before handing off:

**1. Root mode.** If `id -u == 0` **and** `HERETIC_RUN_AS_ROOT` is set: export
`HOME=/home/${AGENT_USER:-agent}` and `USER=root`, print `Running as root (HOME=$HOME)`.
This is what keeps every bind-mounted config resolvable under `--root`.

**2. `setup_tool_wrappers()`.** For each runtime→command set

```
node   → npm npx pnpm yarn node
python → python python3 pip pip3 poetry pytest ruff black mypy
java   → java javac mvn gradle
go     → go gofmt
rust   → cargo rustc rustfmt clippy
```

it writes `/opt/sidecar/wrappers/<cmd>` **only for commands that are not already on PATH**
(PATH is scanned with the wrapper dir removed, so wrappers never shadow real tools). A
runtime present in `BUILD_SIDECARS` routes to `sidecar-exec <runtime> <cmd> "$@"`; otherwise,
if `SSH_HOST` is set, to `ssh-exec <cmd> "$@"`. With neither backend configured it returns
immediately. If a backend *is* configured but the dir is not writable it **exits 1** with
`FATAL: /opt/sidecar/wrappers is not writable by <user> (uid <n>); tool backends disabled`.
Success prints `Tool wrappers: <n> commands configured`.

**3. Mode detection.**

- **Interactive mode** (`PROMPT_FILE` empty): prints a banner with detected tool versions and
  the agent CLI version, then `exec /bin/bash`.
- **Workflow mode** (`PROMPT_FILE` set): reads the prompt file (missing → exit 1), configures
  git credentials from `GH_TOKEN`/`GITHUB_TOKEN` (`credential.helper store` +
  `~/.git-credentials`), sets `user.email=agent@example.com` / `user.name=Heretic Agent`,
  picks up `core.hooksPath` from `$REPO_PATH/.githooks` or `/workspace/.githooks`, copies
  agent settings (`$HERETIC_DIR|/workspace/.heretic/claude-settings.json` →
  `~/.claude/settings.json`; `opencode.json` → `~/.config/opencode/config.json`), expands
  `AGENT_ARGS` (with `file:<path>` → file contents and `exec:<cmd>` → command output), then
  `cd "$REPO_PATH"` and execs the agent:

| `AGENT_TYPE` | command |
| --- | --- |
| `claude` | `claude --print --output-format ${AGENT_OUTPUT_FORMAT:-stream-json} [--verbose] <args> "$PROMPT"` |
| `copilot` | `copilot <args> "$PROMPT"` |
| `opencode` | `opencode <args> "$PROMPT"` |
| `gemini` | `gemini <args> "$PROMPT"` |
| other | `ERROR: Unknown agent type: …` exit 1 |

Workflow mode is how the images are used outside `heretic-cli run` (CI, orchestrators):

```bash
docker run -it --rm \
  -e PROMPT_FILE=/workspace/prompt.md \
  -e REPO_PATH=/workspace \
  -v $(pwd):/workspace \
  heretic-agent:latest
```

## `image generate`

Prints one artifact to stdout — pipe it, diff it, or commit it.

| `--format` | Output |
| --- | --- |
| `dockerfile` (default) | the Dockerfile for the given tool flags (first `--agent`, `--combined` honored) |
| `entrypoint` | the embedded `entrypoint.sh` |
| `ssh-exec` | the SSH backend client script |
| `sidecar-exec` | the HTTP build-sidecar client script |
| `sidecar-dockerfile` | builder image Dockerfile; needs `--runtime` (+ `--runtime-version`, `--go-builder`, `--port`) |
| `exec-server` | the vendored Go `exec-server` `main.go` |

Invalid format → `Invalid format '<x>'. Use: dockerfile, entrypoint, ssh-exec, sidecar-exec, sidecar-dockerfile, exec-server` → exit 1.
Invalid `--runtime` → `Invalid sidecar runtime '<x>'. Use one of: node, python, java, go, rust`.

```bash
heretic-cli image generate --with-all > Dockerfile
heretic-cli image generate --format entrypoint > entrypoint.sh
heretic-cli image generate --format sidecar-dockerfile --runtime python --runtime-version 3.12
```

## Examples

```bash
# default: claude agent on node:22-bookworm-slim with gh
heretic-cli image build

# preview only
heretic-cli image build --dry-run

# python + go tooling, custom name/tag
heretic-cli image build --with-python --python-version 3.12 --with-go -n acme-agent -t dev

# all four agent CLIs in one image
heretic-cli image build --agent all --combined -n heretic-agent -t all

# one image per agent
heretic-cli image build --agent claude --agent gemini

# multi-arch push to GHCR
heretic-cli image build --with-all -r ghcr.io/acme -t 1.0.0 -a both -p

# non-default container user (match your host uid to avoid root-owned files)
heretic-cli image build --agent-uid 501 --agent-gid 20
```

## Gotchas

- `--push` without `--registry` on a single-platform build silently skips the push.
- `--arch both --load` fails in buildx; combine `both` with `--push`.
- The Java block pins JDK `<ver>.0.2+13`, Maven 3.9.6 and Gradle 8.5 by URL — those URLs
  break for versions Temurin has moved; prefer a JDK base image if you need something else.
- `--python-version` uses the **deadsnakes PPA**, which only exists on Ubuntu bases; with the
  default Debian base pass `--with-python` alone (distro default) or use a `python:` base.
- Rust installs under `/root/.cargo` and is copied into the agent home; `PATH` for the agent
  user comes from `.bashrc`, so non-login shells may not see `cargo`.
- The image expects the wrappers dir to be owned by `AGENT_UID`; changing `--agent-uid`
  after the fact (e.g. via `extra.user`) can trip the FATAL writability check.
- Images built before the `ENTRYPOINT` bake exist in the wild: `--root` and the tool backends
  will not work there. Rebuild, or rely on `run --root`'s entrypoint bind-mount.
- `heretic-cli image` never pushes to or reads from your profiles — set the resulting image
  name in the profile yourself (`agents edit`).
