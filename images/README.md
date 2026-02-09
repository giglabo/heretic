# Heretic Agent Image Builder

A unified build system for creating agent images with configurable tools and agent types for both local development and production/K8s deployments.

Supported agents: **Claude**, **Copilot**, **OpenCode**, **Gemini**

## Quick Start

```bash
# Build Claude agent (default)
./build-heretic-agent

# Build specific agent type
./build-heretic-agent --agent copilot
./build-heretic-agent --agent opencode
./build-heretic-agent --agent gemini

# Build multiple agents in ONE image (combined mode)
./build-heretic-agent --agent claude --agent copilot --combined

# Build all agent types (separate images)
./build-heretic-agent --agent all

# Build with Python for local development
./build-heretic-agent --agent claude --with-python --with-docker

# Build with specific tool versions
./build-heretic-agent --python-version 3.12 --go-version 1.22.0 --node-version 20

# Build with all tools for multi-arch
./build-heretic-agent --agent gemini --with-all --arch both --push --registry ghcr.io/myorg
```

## Features

- **Multiple agent types**: Claude, Copilot, OpenCode, Gemini - build one, multiple, or all at once
- **Combined mode**: Install multiple agents in ONE image, select at runtime with `AGENT_TYPE`
- **Flexible agent selection**: Specify multiple `--agent` flags to build exactly what you need
- **Tool version control**: Control Python (3.11-3.13), Node.js (18-22), Go (1.21-1.23), Java (11-21), Rust (stable/nightly/beta)
- **Configurable base image**: Choose between slim (K8s) or full (local dev) base images
- **Modular tool selection**: Include only the tools you need
- **Three execution backends**: Fat/local, sidecar (HTTP), and SSH — resolved at runtime
- **Multi-arch support**: Build for amd64, arm64, or both
- **Universal entrypoint**: Works in both interactive and workflow modes
- **Docker-in-Docker ready**: Optional Docker CLI for container operations

## Orchestrator Integration

When invoked by orchestrator-service, containers receive:

### Command (Explicit)
```bash
# Example command passed to docker.containers.run(command=...)
# For Claude agent:
["claude", "--print", "/workspace/.heretic/prompts/design/starter.md",
 "--output-format", "stream-json", "--model", "opus"]

# For Copilot agent:
["copilot", "suggest", "implement user auth"]

# For OpenCode agent:
["opencode", "chat"]

# For Gemini agent:
["gemini", "code", "chat"]
```

### Environment Variables

The entrypoint uses these environment variables for setup:

**Infrastructure:**
- `BUILD_SIDECARS` - JSON dict of sidecar endpoints for tool routing (enables sidecar backend)
- `SSH_HOST` - Remote SSH host for tool execution (enables SSH backend)
- `SSH_USER` - SSH username (default: current user)
- `SSH_HOST_CWD` - Working directory on remote host
- `GH_TOKEN` - GitHub token for git credential helper
- `REPO_PATH` - Working directory path (default: `/workspace`)

**Git Configuration:**
- `GIT_AUTHOR_NAME` - Git user name (default: `Claude Agent`)
- `GIT_AUTHOR_EMAIL` - Git user email (default: `agent@cloud-agents.io`)

**Agent Settings:**
- **Claude**: Entrypoint looks for `claude-settings.json` in `${HERETIC_DIR:-/workspace/.heretic}/`, copies to `~/.claude/settings.json`
- **OpenCode**: Entrypoint looks for `opencode.json` in `${HERETIC_DIR:-/workspace/.heretic}/`, copies to `~/.config/opencode/config.json`
- **Gemini**: Uses `GOOGLE_API_KEY` environment variable
- **Copilot**: Uses `GITHUB_TOKEN` or `GH_TOKEN` environment variable

**Any additional environment variables** are passed through to the command execution environment.

> **For orchestrator-specific environment variables** (EXEC_ID, TASK_ID, KANBAN_CARD_ID, HERETIC_DIR, etc.), see [`orchestrator-service/AGENTS.md`](../orchestrator-service/AGENTS.md#environment-variables)

**NOT passed (now in command):**
- ❌ `PROMPT_FILE` - use command arg instead
- ❌ `AGENT_ARGS` - included in command instead
- ❌ `AGENT_OUTPUT_FORMAT` - included in command instead

## Execution Backends

Tool commands (npm, python, go, etc.) are resolved at container start using three backends in priority order:

| Priority | Backend | Detection | How It Works |
|----------|---------|-----------|--------------|
| 1 | **Fat/local** | Binary in PATH | Tool installed in image, used directly |
| 2 | **Sidecar** | `BUILD_SIDECARS` env var | HTTP wrappers via `sidecar-exec` |
| 3 | **SSH** | `SSH_HOST` env var | SSH wrappers via `ssh-exec` |

The entrypoint generates wrapper scripts in `/opt/sidecar/wrappers/` for any command not natively available. A fat image with `--with-python` will use local python directly; a slim image with `BUILD_SIDECARS` set will route python to the sidecar; a slim image with `SSH_HOST` will route python over SSH.

**No build-time flags needed** — the same image works with any backend depending on the environment variables set at runtime.

## Usage

### Basic Build

```bash
# Default build (Claude agent, slim, node-based)
./build-heretic-agent

# Build specific agent type
./build-heretic-agent --agent copilot

# Build multiple specific agents
./build-heretic-agent --agent copilot --agent gemini
./build-heretic-agent --agent claude --agent opencode

# Build all agent types
./build-heretic-agent --agent all

# With specific tools
./build-heretic-agent --agent claude --with-python --with-node

# Multiple agents with tools
./build-heretic-agent --agent claude --agent copilot --with-all

# With all tools
./build-heretic-agent --agent gemini --with-all
```

### Local Development

For local development with a full terminal experience:

```bash
./build-heretic-agent \
    --agent claude \
    --base ubuntu:22.04 \
    --with-python \
    --with-docker \
    --with-go \
    --name claude-dev

# Run interactively
docker run -it --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v $(pwd):/workspace \
    claude-dev:latest
```

### Production / K8s

For production deployments with sidecar-based or SSH-based tools:

```bash
# Build a slim image (no built-in tools)
./build-heretic-agent \
    --agent gemini \
    --base node:22-bookworm-slim \
    --name gemini-prod

# Run with sidecar backend
docker run -i --rm \
    -e BUILD_SIDECARS='{"python":{"internal_url":"http://python-sidecar:8080"}}' \
    -e PROMPT_FILE=/workspace/prompt.md \
    -e REPO_PATH=/workspace \
    -v $(pwd):/workspace \
    --entrypoint /home/agent/entrypoint.sh \
    gemini-prod:latest

# Or run with SSH backend
docker run -i --rm \
    -e SSH_HOST=devbox.internal \
    -e SSH_HOST_CWD=/workspace \
    -e PROMPT_FILE=/workspace/prompt.md \
    -v $(pwd):/workspace \
    -v ~/.ssh/id_rsa:/home/agent/.ssh/id_rsa:ro \
    --entrypoint /home/agent/entrypoint.sh \
    gemini-prod:latest
```

### Multi-Architecture Build

```bash
# Build for ARM64 (Apple Silicon)
./build-heretic-agent --agent claude --arch arm64 --with-python

# Build for AMD64
./build-heretic-agent --agent copilot --arch amd64 --with-python

# Build for both and push to registry
./build-heretic-agent \
    --agent gemini \
    --arch both \
    --with-all \
    --push \
    --registry ghcr.io/myorg

# Build ALL agent types for multi-arch
./build-heretic-agent \
    --agent all \
    --arch both \
    --push \
    --registry ghcr.io/myorg
```

## Command-Line Options

### Agent Options

| Option | Description | Default |
|--------|-------------|---------|
| `--agent TYPE` | Agent type: `claude`, `copilot`, `opencode`, `gemini`, `all`<br/>Can be specified multiple times to build multiple agents | `claude` |

### Image Options

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --name NAME` | Image name | `heretic-agent` |
| `-t, --tag TAG` | Image tag | `latest` |
| `-r, --registry REG` | Registry prefix | (none) |
| `-p, --push` | Push after build | `false` |
| `--dry-run` | Print Dockerfile only | `false` |

### Architecture Options

| Option | Description | Default |
|--------|-------------|---------|
| `-a, --arch ARCH` | Architecture: `amd64`, `arm64`, `both` | Current platform |

### Base Image Options

| Option | Description |
|--------|-------------|
| `--base IMAGE` | Base Docker image |

**Recommended base images:**

| Image | Use Case |
|-------|----------|
| `node:22-bookworm-slim` | Slim, good for K8s/production |
| `ubuntu:22.04` | Full terminal, good for local dev |
| `debian:bookworm-slim` | Middle ground |

### Built-in Tool Options

| Option | Includes | Default Version | Version Control |
|--------|----------|----------------|-----------------|
| `--with-python` | Python 3, pip, poetry, pytest, black, ruff, mypy | 3.13 | `--python-version 3.11\|3.12\|3.13` |
| `--with-node` | Node.js (npm, yarn, pnpm via corepack) | 22 | `--node-version 18\|20\|22` |
| `--with-go` | Go compiler, gofmt | 1.23.4 | `--go-version 1.21.5\|1.22.0\|1.23.4` |
| `--with-java` | Java (Temurin), Maven 3.9.6, Gradle 8.5 | 21 | `--java-version 11\|17\|21` |
| `--with-rust` | Rust, Cargo, rustfmt, clippy | stable | `--rust-version stable\|nightly\|beta\|1.75` |
| `--with-docker` | Docker CLI (for DinD/DooD) | latest | (no version control) |
| `--with-github-cli` | GitHub CLI (gh) | latest | (no version control) |
| `--with-all` | Enable ALL built-in tools | - | (use individual version flags) |

**Version Control Examples:**
```bash
# Python 3.12 instead of default 3.13
./build-heretic-agent --python-version 3.12

# Node.js 20 instead of default 22
./build-heretic-agent --node-version 20

# Go 1.22.0 instead of default 1.23.4
./build-heretic-agent --go-version 1.22.0

# Java 17 instead of default 21
./build-heretic-agent --java-version 17

# Rust nightly instead of default stable
./build-heretic-agent --rust-version nightly

# Combine multiple version overrides
./build-heretic-agent --python-version 3.11 --go-version 1.21.5 --java-version 17
```

**Notes:**
- Version flags automatically enable the corresponding `--with-*` flag
- Node.js is **always installed** for non-node base images (required for agent CLIs)
- For `node:*` base images, the Node.js version is determined by the base image tag

### Sidecar Wrapper Options (Deprecated)

> **Deprecated:** `--with-sidecar-*` build flags are no longer needed. Tool wrappers are now generated at runtime based on `BUILD_SIDECARS` or `SSH_HOST` environment variables. The flags are accepted but ignored with a warning.

Runtime tool wrappers cover these commands per runtime:

| Runtime | Commands |
|---------|----------|
| python | python, python3, pip, pip3, poetry, pytest, black, ruff, mypy |
| node | node, npm, npx, yarn, pnpm |
| go | go, gofmt |
| java | java, javac, mvn, gradle |
| rust | cargo, rustc, rustfmt, clippy |

### Agent Options

| Option | Description | Default |
|--------|-------------|---------|
| `--agent-user USER` | Agent username | `agent` |
| `--agent-uid UID` | Agent user ID | `1000` |
| `--agent-gid GID` | Agent group ID | `1000` |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_TYPE` | Default agent type (claude, copilot, opencode, gemini, all) |
| `IMAGE_NAME` | Default image name |
| `IMAGE_TAG` | Default image tag |
| `REGISTRY` | Default registry |
| `BASE_IMAGE` | Default base image |

## Agent Types

| Type | CLI Package | Configuration | Environment Variables |
|------|-------------|---------------|----------------------|
| `claude` | `@anthropic-ai/claude-code` | `~/.claude/settings.json` | `ANTHROPIC_API_KEY`, `GH_TOKEN` |
| `copilot` | `@github/copilot` | GitHub token only | `GITHUB_TOKEN`, `GH_TOKEN` |
| `opencode` | `opencode-ai` | `~/.config/opencode/config.json` | `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` |
| `gemini` | `@google/gemini-cli` | Environment only | `GOOGLE_API_KEY`, `GITHUB_TOKEN` |

## Entrypoint Behavior

The generated entrypoint script supports two modes:

### 1. Interactive Mode (Default)

When `PROMPT_FILE` is not set, the container starts an interactive shell:

```bash
docker run -it claude-fat-cat:latest
# Starts bash shell with all tools available
```

### 2. Workflow Mode

When `PROMPT_FILE` is set, the container executes the agent with the prompt:

```bash
docker run -i \
    -e PROMPT_FILE=/workspace/prompt.md \
    -e REPO_PATH=/workspace \
    heretic-agent:latest
```

This is the mode used by the orchestrator. The agent command executed depends on the `AGENT_TYPE` environment variable.

## Docker-in-Docker (DinD) vs Docker-outside-of-Docker (DooD)

### DooD Pattern (Recommended)

Mount the host Docker socket:

```bash
docker run -it \
    -v /var/run/docker.sock:/var/run/docker.sock \
    heretic-agent:latest
```

**Pros:**
- Simple, no privileged mode needed
- Containers run on host daemon
- Images cached on host

**Cons:**
- Security: container has full Docker access
- Not suitable for untrusted workloads

### True DinD (Nested Docker)

Requires privileged mode (not recommended for K8s):

```bash
docker run -it --privileged \
    heretic-agent:latest \
    dockerd &
```

**Pros:**
- Full isolation
- Can run Docker daemon inside

**Cons:**
- Requires privileged mode
- More complex
- Not supported in most K8s environments

## Sidecar Backend

Set `BUILD_SIDECARS` at runtime to route tool commands to sidecar containers via HTTP:

```bash
# Run with sidecar backend
docker run -it --rm \
    -e BUILD_SIDECARS='{"python":{"internal_url":"http://python-sidecar:8080"}}' \
    heretic-agent:latest

# Inside the container, commands are transparently routed:
python3 script.py    # → HTTP POST to python sidecar
pytest tests/        # → HTTP POST to python sidecar
```

## SSH Backend

Set `SSH_HOST` at runtime to route tool commands to a remote host via SSH:

```bash
# Run with SSH backend
docker run -it --rm \
    -e SSH_HOST=devbox.example.com \
    -e SSH_USER=developer \
    -e SSH_HOST_CWD=/home/developer/project \
    -v ~/.ssh/id_rsa:/home/agent/.ssh/id_rsa:ro \
    heretic-agent:latest

# Inside the container, commands are transparently routed:
npm install          # → ssh developer@devbox.example.com "cd /home/developer/project && npm install"
python3 script.py   # → ssh developer@devbox.example.com "cd /home/developer/project && python3 script.py"
```

## Examples

### Example 1: Local Development Image

```bash
./build-heretic-agent \
    --agent claude \
    --base ubuntu:22.04 \
    --with-python \
    --with-go \
    --with-docker \
    --with-github-cli \
    --name claude-local \
    --tag dev

# Run
docker run -it --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v $(pwd):/workspace \
    -w /workspace \
    claude-local:dev
```

### Example 2: Slim Image with Runtime Backends

```bash
./build-heretic-agent \
    --agent gemini \
    --base node:22-bookworm-slim \
    --with-github-cli \
    --name gemini-prod \
    --tag v1.0.0

# Run with sidecars (set BUILD_SIDECARS at runtime)
BUILD_SIDECARS='{"python":{"internal_url":"http://python-sidecar:8080"}}' \
    docker compose up gemini-agent python-sidecar

# Or run with SSH backend
SSH_HOST=devbox.internal docker compose up gemini-agent
```

### Example 3: Multi-Arch Registry Push

```bash
./build-heretic-agent \
    --agent copilot \
    --with-python \
    --with-node \
    --with-docker \
    --arch both \
    --push \
    --registry ghcr.io/myorg \
    --name copilot-agent \
    --tag v2.0.0

# Results in:
# - ghcr.io/myorg/copilot-agent:v2.0.0 (multi-arch manifest)
```

### Example 4: Build Multiple Specific Agents

```bash
# Build just copilot and gemini
./build-heretic-agent --agent copilot --agent gemini --with-python

# Results in:
# - heretic-agent-copilot:latest
# - heretic-agent-gemini:latest
```

### Example 5: Build All Agent Types

```bash
./build-heretic-agent --agent all --with-all --push --registry ghcr.io/myorg

# Results in:
# - ghcr.io/myorg/heretic-agent:latest (Claude)
# - ghcr.io/myorg/heretic-agent-copilot:latest
# - ghcr.io/myorg/heretic-agent-opencode:latest
# - ghcr.io/myorg/heretic-agent-gemini:latest
```

## Troubleshooting

### Tool commands not found at runtime

Wrappers are generated at container start. Verify:

```bash
# Check what wrappers were generated
ls /opt/sidecar/wrappers/

# Check if BUILD_SIDECARS or SSH_HOST is set
env | grep -E 'BUILD_SIDECARS|SSH_HOST'
```

### Architecture mismatch on Apple Silicon

```bash
# Build explicitly for ARM64
./build-heretic-agent --agent claude --arch arm64

# Or use Rosetta for AMD64
./build-heretic-agent --agent claude --arch amd64
```

### Image too large

Use a slimmer base and fewer tools:

```bash
./build-heretic-agent \
    --agent claude \
    --base node:22-alpine \
    --with-github-cli
```

## Comparison with Legacy Images

| Image | Base | Tools | Agent Type | Use Case |
|-------|------|-------|------------|----------|
| `claude` (legacy) | `node:22-bookworm-slim` | Node only | Claude | Basic agent |
| `claude-zai` (legacy) | Custom | Node + Z.AI config | Claude | Z.AI backend |
| `test-agent` (legacy) | `claude` + DinD | Node + Docker CLI | Claude | Testing with DinD |
| `copilot` (legacy) | `node:22-bookworm-slim` | Node only | Copilot | GitHub Copilot |
| `opencode` (legacy) | `node:22-bookworm-slim` | Node only | OpenCode | OpenCode |
| `gemini` (legacy) | `node:22-bookworm-slim` | Node only | Gemini | Gemini |
| **`heretic-agent` (this)** | **Configurable** | **Fat + sidecar + SSH** | **All** | **Universal** |
