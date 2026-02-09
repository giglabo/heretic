# Heretic Agent - User Guide

Complete guide for using the Heretic Agent images locally with Docker Compose.

Supports multiple agent types: **Claude**, **Copilot**, **OpenCode**, and **Gemini**.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Agent Types](#agent-types)
3. [Building Images](#building-images)
   - [Basic Builds](#basic-builds)
   - [Combined Mode (Multiple Agents in One Image)](#combined-mode-multiple-agents-in-one-image)
   - [Python Version Control](#python-version-control)
   - [Multiple Agent Builds](#multiple-agent-builds)
   - [Multi-Architecture Build](#multi-architecture-build)
4. [Docker Compose Setups](#docker-compose-setups)
   - [Basic Setup (No DinD)](#basic-setup-no-dind)
   - [Combined Agent Image](#combined-agent-image)
   - [With Docker-in-Docker (DooD)](#with-docker-in-docker-dood)
   - [With Sidecars](#with-sidecars)
   - [With SSH Backend](#with-ssh-backend)
   - [Multi-Agent Setup](#multi-agent-setup)
5. [Environment Variables](#environment-variables)
6. [Usage Examples](#usage-examples)
7. [Included Tools](#included-tools)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Claude Agent (Default)

```bash
# 1. Build the image
./build-heretic-agent --with-python --with-docker --name claude-local

# 2. Run interactively
docker run -it --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd):/workspace \
  claude-local:latest

# 3. Inside container
claude --print "Hello, world!"
```

### Combined Image (Multiple Agents in One Image)

**NEW**: Build one image with multiple agents, select at runtime with `AGENT_TYPE`:

```bash
# 1. Build combined image with Claude and Copilot
./build-heretic-agent \
  --agent claude --agent copilot \
  --combined \
  --with-python --with-docker \
  --name heretic-local

# 2. Run with Claude
docker run -it --rm \
  -e AGENT_TYPE=claude \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v $(pwd):/workspace \
  heretic-local:latest

# 3. Or run with Copilot (same image!)
docker run -it --rm \
  -e AGENT_TYPE=copilot \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -v $(pwd):/workspace \
  heretic-local:latest
```

### Other Agents (Separate Images)

```bash
# Build Copilot agent
./build-heretic-agent --agent copilot --name copilot-local

# Build Gemini agent
./build-heretic-agent --agent gemini --name gemini-local

# Build OpenCode agent
./build-heretic-agent --agent opencode --name opencode-local
```

---

## Agent Types

| Agent | CLI Package | Use Case | Authentication |
|-------|-------------|----------|----------------|
| **Claude** | `@anthropic-ai/claude-code` + `mcp-remote` | Anthropic Claude Code assistant | `ANTHROPIC_API_KEY` |
| **Copilot** | `@github/copilot` | GitHub Copilot CLI | `GITHUB_TOKEN` |
| **OpenCode** | `opencode-ai` | OpenCode assistant | `ANTHROPIC_API_KEY` |
| **Gemini** | `@google/gemini-cli` + `mcp-remote` | Google Gemini assistant | `GOOGLE_API_KEY` |

**Build Options:**
- **Separate images** (default): Each agent gets its own image (e.g., `heretic-agent-copilot:latest`)
- **Combined image** (`--combined` flag): All specified agents in one image, select with `AGENT_TYPE` env var

**Example:**
```bash
# Separate images (default)
./build-heretic-agent --agent claude --agent copilot
# Creates: heretic-agent:latest, heretic-agent-copilot:latest

# Combined image (NEW)
./build-heretic-agent --agent claude --agent copilot --combined
# Creates: heretic-agent:latest (contains both CLIs)
```

### Agent-Specific Configuration

#### Claude
- **Settings**: `~/.claude/settings.json`
- **Config source**: `${HERETIC_DIR}/.heretic/claude-settings.json`
- **Env vars**: `ANTHROPIC_API_KEY`, `GH_TOKEN`

#### Copilot
- **Settings**: Token-based (no config file)
- **Env vars**: `GITHUB_TOKEN`, `GH_TOKEN`

#### OpenCode
- **Settings**: `~/.config/opencode/config.json`
- **Config source**: `${HERETIC_DIR}/.heretic/opencode.json`
- **Env vars**: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`

#### Gemini
- **Settings**: Environment variables only
- **Env vars**: `GOOGLE_API_KEY`, `GITHUB_TOKEN`

---

## Building Images

### Basic Builds

```bash
# Default (Claude agent, slim)
./build-heretic-agent

# Specific agent type
./build-heretic-agent --agent copilot
./build-heretic-agent --agent gemini --name gemini-dev

# With Python 3.13 (default) for local development
./build-heretic-agent --agent claude --with-python --with-docker --name claude-dev

# With all tools
./build-heretic-agent --agent opencode --with-all --name opencode-full

# Slim image (tools routed via sidecar or SSH at runtime)
./build-heretic-agent --agent claude --with-github-cli --name claude-slim
```

### Combined Mode (Multiple Agents in One Image)

**NEW**: The `--combined` flag installs multiple agent CLIs in a single image. Select which agent to use at runtime with the `AGENT_TYPE` environment variable.

**Advantages:**
- **One image, multiple agents**: Deploy once, use many
- **Smaller total footprint**: No duplicate base layers
- **Easier management**: Single image tag to track
- **Runtime flexibility**: Switch agents without rebuilding

**Example:**
```bash
# Build combined image with Claude and Copilot
./build-heretic-agent \
  --agent claude --agent copilot \
  --combined \
  --with-python \
  --name heretic-multi

# Produces one image: heretic-multi:latest (includes both CLIs)
```

**Usage:**
```bash
# Use Claude
docker run -it --rm \
  -e AGENT_TYPE=claude \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  heretic-multi:latest

# Use Copilot (same image!)
docker run -it --rm \
  -e AGENT_TYPE=copilot \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  heretic-multi:latest
```

**Build all agents in one image:**
```bash
./build-heretic-agent \
  --agent claude --agent copilot --agent opencode --agent gemini \
  --combined \
  --with-all \
  --name heretic-fat
```

### Tool Version Control

**NEW**: Control versions for all major tools (Python, Node.js, Go, Java, Rust).

#### Python Version Control

Control Python version with `--python-version` flag (default: 3.13).

```bash
# Python 3.13 (default)
./build-heretic-agent --agent claude --with-python

# Explicit Python 3.13
./build-heretic-agent --agent claude --python-version 3.13

# Python 3.12
./build-heretic-agent --agent claude --python-version 3.12

# Python 3.11
./build-heretic-agent --agent claude --python-version 3.11
```

**Included with Python:**
- `pip` (installed via get-pip.py bootstrap)
- `poetry` (Python packaging tool)
- `pytest` (testing framework)
- `black` (code formatter)
- `ruff` (fast linter)
- `mypy` (type checker)

#### Node.js Version Control

Control Node.js version with `--node-version` flag (default: 22).

```bash
# Node.js 22 (default)
./build-heretic-agent --node-version 22

# Node.js 20 LTS
./build-heretic-agent --node-version 20

# Node.js 18 LTS
./build-heretic-agent --node-version 18
```

**Note:** Node.js is **automatically installed** for non-node base images (required for agent CLIs). For `node:*` base images, version is determined by the base image tag.

**Included with Node.js:**
- `npm` (package manager)
- `yarn` (via corepack)
- `pnpm` (via corepack)

#### Go Version Control

Control Go version with `--go-version` flag (default: 1.23.4).

```bash
# Go 1.23.4 (default)
./build-heretic-agent --go-version 1.23.4

# Go 1.22.0
./build-heretic-agent --go-version 1.22.0

# Go 1.21.5
./build-heretic-agent --go-version 1.21.5
```

**Included with Go:**
- `go` (compiler)
- `gofmt` (formatter)

#### Java Version Control

Control Java version with `--java-version` flag (default: 21).

```bash
# Java 21 (default)
./build-heretic-agent --java-version 21

# Java 17 LTS
./build-heretic-agent --java-version 17

# Java 11 LTS
./build-heretic-agent --java-version 11
```

**Included with Java:**
- Java (Eclipse Temurin)
- Maven 3.9.6
- Gradle 8.5

#### Rust Version Control

Control Rust version with `--rust-version` flag (default: stable).

```bash
# Rust stable (default)
./build-heretic-agent --rust-version stable

# Rust nightly
./build-heretic-agent --rust-version nightly

# Rust beta
./build-heretic-agent --rust-version beta

# Specific version
./build-heretic-agent --rust-version 1.75
```

**Included with Rust:**
- `cargo` (package manager)
- `rustfmt` (formatter)
- `clippy` (linter)

#### Combining Version Controls

You can specify multiple tool versions in one build:

```bash
# Custom versions for multiple tools
./build-heretic-agent \
  --agent claude \
  --python-version 3.12 \
  --node-version 20 \
  --go-version 1.22.0 \
  --java-version 17 \
  --rust-version nightly \
  --base ubuntu:22.04

# Combined image with specific versions
./build-heretic-agent \
  --agent claude --agent copilot \
  --combined \
  --python-version 3.11 \
  --go-version 1.21.5 \
  --name heretic-custom
```

**Important Notes:**
- Version flags automatically enable the corresponding `--with-*` flag
- Not all version combinations are tested - use standard versions when possible
- For Node.js: when using `node:*` base images, the base image version takes precedence

### Multiple Agent Builds

**Without `--combined`**: Creates separate images for each agent:

```bash
# Build multiple specific agents (creates 2 images)
./build-heretic-agent --agent copilot --agent gemini
# Creates: heretic-agent-copilot:latest, heretic-agent-gemini:latest

# Build all agent types (creates 4 images)
./build-heretic-agent --agent all --with-python
# Creates: heretic-agent:latest, heretic-agent-copilot:latest,
#          heretic-agent-opencode:latest, heretic-agent-gemini:latest

# Build multiple with all tools (creates 2 images)
./build-heretic-agent --agent claude --agent copilot --with-all
# Creates: heretic-agent:latest, heretic-agent-copilot:latest
```

**With `--combined`**: Creates one image with all specified agents:

```bash
# Build multiple agents in ONE image
./build-heretic-agent --agent copilot --agent gemini --combined
# Creates: heretic-agent:latest (contains both CLIs)

# Build all agents in ONE image
./build-heretic-agent --agent all --combined --with-python
# Creates: heretic-agent:latest (contains all 4 agent CLIs)
```

### Multi-Architecture Build

```bash
# For Apple Silicon (M1/M2/M3)
./build-heretic-agent --agent claude --arch arm64 --with-python

# For both AMD64 and ARM64
./build-heretic-agent --agent gemini --arch both --with-all

# Multiple agents, multi-arch
./build-heretic-agent --agent copilot --agent gemini --arch both
```

---

## Docker Compose Setups

### Basic Setup (No DinD)

Simple setup for development without Docker access:

```yaml
# docker-compose.yml
version: "3.8"

services:
  claude:
    image: heretic-agent:latest
    container_name: claude-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - API_TIMEOUT_MS=3000000
    volumes:
      - ./workspace:/workspace
      - ./claude-settings.json:/home/agent/.claude/settings.json:ro
    working_dir: /workspace
    command: /bin/bash
```

Usage:
```bash
# Start
docker compose up -d

# Attach
docker attach claude-agent

# Or exec
docker exec -it claude-agent /bin/bash

# Stop
docker compose down
```

### Combined Agent Image

**NEW**: Use one image with multiple agents, select at runtime with `AGENT_TYPE`:

```yaml
# docker-compose.combined.yml
version: "3.8"

services:
  agent:
    image: heretic-local-fat:latest  # Combined image with multiple agents
    container_name: heretic-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=${AGENT_TYPE:-claude}  # Default to Claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
      - API_TIMEOUT_MS=3000000
    volumes:
      - ./workspace:/workspace
      - ./claude-settings.json:/home/agent/.claude/settings.json:ro
    working_dir: /workspace
    command: /bin/bash
```

Usage:
```bash
# Start with Claude (default)
docker compose -f docker-compose.combined.yml up -d
docker exec -it heretic-agent /bin/bash

# Or start with specific agent type
AGENT_TYPE=copilot docker compose -f docker-compose.combined.yml up -d
docker exec -it heretic-agent /bin/bash

# Switch agents by recreating container
docker compose -f docker-compose.combined.yml down
AGENT_TYPE=gemini docker compose -f docker-compose.combined.yml up -d
```

**Benefits:**
- One image for all agents (smaller disk usage)
- Easy agent switching without rebuilding
- Consistent tooling across all agents
- Simpler deployment pipeline

### With Docker-in-Docker (DooD)

For running Docker commands inside the agent (mounts host Docker socket):

```yaml
# docker-compose.dind.yml
version: "3.8"

services:
  claude:
    image: heretic-agent:latest
    container_name: claude-dind
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - API_TIMEOUT_MS=3000000
    volumes:
      - ./workspace:/workspace
      - ./claude-settings.json:/home/agent/.claude/settings.json:ro
      - /var/run/docker.sock:/var/run/docker.sock  # Docker socket mount
    working_dir: /workspace
    command: /bin/bash
```

Usage:
```bash
# Start with DinD
docker compose -f docker-compose.dind.yml up -d

# Exec and test Docker
docker exec -it claude-dind /bin/bash
$ docker ps
$ docker run hello-world
```

**Security Note:** Mounting the Docker socket gives the container full access to the host Docker daemon. Only use this for trusted workloads.

### With Sidecars

For using external build sidecars (keeps agent image slim):

```yaml
# docker-compose.sidecars.yml
version: "3.8"

services:
  claude:
    image: heretic-agent:latest
    container_name: claude-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - BUILD_SIDECARS={"python":{"internal_url":"http://python-sidecar:8080"},"node":{"internal_url":"http://node-sidecar:8080"}}
    volumes:
      - ./workspace:/workspace
    working_dir: /workspace
    command: /bin/bash
    depends_on:
      - python-sidecar
      - node-sidecar

  python-sidecar:
    image: builder-python:latest
    container_name: python-sidecar
    volumes:
      - ./workspace:/workspace
    environment:
      - SIDECAR_RUNTIME=python

  node-sidecar:
    image: builder-node:latest
    container_name: node-sidecar
    volumes:
      - ./workspace:/workspace
    environment:
      - SIDECAR_RUNTIME=node
```

Usage:
```bash
# Start agent with sidecars
docker compose -f docker-compose.sidecars.yml up -d

# Test sidecar routing
docker exec -it claude-agent /bin/bash
$ python3 --version  # Routes to python-sidecar
$ npm --version      # Routes to node-sidecar
```

### With SSH Backend

For routing tool commands to a remote host via SSH:

```yaml
# docker-compose.ssh.yml
version: "3.8"

services:
  claude:
    image: heretic-agent:latest
    container_name: claude-ssh
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - API_TIMEOUT_MS=3000000
      - SSH_HOST=${SSH_HOST}
      - SSH_PORT=${SSH_PORT:-22}
      - SSH_USER=${SSH_USER:-agent}
      - SSH_HOST_CWD=${SSH_HOST_CWD:-/workspace}
    volumes:
      - ./workspace:/workspace
      - ./claude-settings.json:/home/agent/.claude/settings.json:ro
      - ${SSH_KEY_FILE:-/dev/null}:/home/agent/.ssh/id_rsa:ro
    working_dir: /workspace
    command: /bin/bash
```

Usage:
```bash
# Start with SSH backend
SSH_HOST=devbox.example.com SSH_KEY_FILE=~/.ssh/id_rsa \
    docker compose -f docker-compose.ssh.yml up -d

# Test SSH routing
docker exec -it claude-ssh /bin/bash
$ python3 --version  # Routes via SSH to devbox.example.com
$ npm --version      # Routes via SSH to devbox.example.com
```

### Multi-Agent Setup

Run multiple agent types simultaneously:

```yaml
# docker-compose.multi.yml
version: "3.8"

services:
  claude:
    image: heretic-agent:latest
    container_name: claude-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - ./workspace:/workspace
      - ./claude-settings.json:/home/agent/.claude/settings.json:ro
    working_dir: /workspace
    command: /bin/bash

  copilot:
    image: heretic-agent-copilot:latest
    container_name: copilot-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=copilot
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - ./workspace:/workspace
    working_dir: /workspace
    command: /bin/bash

  gemini:
    image: heretic-agent-gemini:latest
    container_name: gemini-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=gemini
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
    volumes:
      - ./workspace:/workspace
    working_dir: /workspace
    command: /bin/bash

  opencode:
    image: heretic-agent-opencode:latest
    container_name: opencode-agent
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=opencode
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - ./workspace:/workspace
      - ./opencode.json:/home/agent/.config/opencode/config.json:ro
    working_dir: /workspace
    command: /bin/bash
```

Usage:
```bash
# Start all agents
docker compose -f docker-compose.multi.yml up -d

# Use specific agent
docker exec -it claude-agent /bin/bash
docker exec -it copilot-agent /bin/bash
docker exec -it gemini-agent /bin/bash
docker exec -it opencode-agent /bin/bash
```

### Complete Production Setup

Full setup with DinD, sidecars, and MCP:

```yaml
# docker-compose.full.yml
version: "3.8"

services:
  claude:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        - BASE_IMAGE=node:22-bookworm-slim
        - AGENT_TYPE=claude
    image: heretic-agent:latest
    container_name: claude-prod
    stdin_open: true
    tty: true
    environment:
      - AGENT_TYPE=claude
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - API_TIMEOUT_MS=3000000
      - BUILD_SIDECARS=${BUILD_SIDECARS}
      - MCP_CONFIG=${MCP_CONFIG}
    volumes:
      - ./workspace:/workspace
      - /var/run/docker.sock:/var/run/docker.sock
      - ./claude-settings.json:/home/agent/.claude/settings.json:ro
      - ./mcp.json:/workspace/.mcp.json:ro
    working_dir: /workspace
    command: /bin/bash
    profiles: ["agent"]

  # Optional: Local MCP server for testing
  mcp-server:
    image: mcp-server:latest
    container_name: mcp-local
    ports:
      - "8080:8080"
    profiles: ["mcp"]

  # Optional: Build sidecars
  python-sidecar:
    image: builder-python:latest
    container_name: python-sidecar
    volumes:
      - ./workspace:/workspace
    profiles: ["sidecars"]

  node-sidecar:
    image: builder-node:latest
    container_name: node-sidecar
    volumes:
      - ./workspace:/workspace
    profiles: ["sidecars"]
```

Usage:
```bash
# Agent only
docker compose --profile agent up -d

# Agent with MCP
docker compose --profile agent --profile mcp up -d

# Agent with sidecars
docker compose --profile agent --profile sidecars up -d

# Everything
docker compose --profile agent --profile mcp --profile sidecars up -d
```

---

## Environment Variables

### Agent-Specific Required Variables

| Agent | Variable | Description | Example |
|-------|----------|-------------|---------|
| Claude | `ANTHROPIC_API_KEY` | Anthropic API key | `sk-ant-...` |
| Copilot | `GITHUB_TOKEN` | GitHub token with Copilot access | `ghp_...` |
| OpenCode | `ANTHROPIC_API_KEY` | Anthropic API key | `sk-ant-...` |
| Gemini | `GOOGLE_API_KEY` | Google AI API key | `AIza...` |

### Common Required

| Variable | Description | Example |
|----------|-------------|---------|
| `AGENT_TYPE` | Agent type identifier | `claude`, `copilot`, `opencode`, `gemini` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `API_TIMEOUT_MS` | API request timeout | `3000000` (50 min) |
| `BUILD_SIDECARS` | Sidecar configuration JSON | `{}` |
| `MCP_CONFIG` | MCP server configuration | `{}` |
| `GH_TOKEN` | GitHub token for git operations | - |
| `GITHUB_TOKEN` | Alias for GH_TOKEN | - |
| `GIT_AUTHOR_NAME` | Git commit author name | `Heretic Agent` |
| `GIT_AUTHOR_EMAIL` | Git commit author email | `agent@cloud-agents.io` |
| `SIDECAR_TIMEOUT` | Sidecar command timeout | `600` (10 min) |
| `SSH_HOST` | SSH backend host | - |
| `SSH_PORT` | SSH port | `22` |
| `SSH_USER` | SSH username | `agent` |
| `SSH_KEY_PATH` | SSH key path inside container | `/home/agent/.ssh/id_rsa` |
| `SSH_KEY_FILE` | SSH key path on host (volume mount) | - |
| `SSH_HOST_CWD` | Working directory on remote host | current directory |
| `HERETIC_DIR` | Directory for agent config files | `/workspace/.heretic` |

### Build Sidecars Format

```json
{
  "python": {
    "internal_url": "http://python-sidecar:8080"
  },
  "node": {
    "internal_url": "http://node-sidecar:8080"
  },
  "go": {
    "internal_url": "http://go-sidecar:8080"
  }
}
```

**Important:** `BUILD_SIDECARS` is set at **runtime**, not build time. This allows the same image to work in different environments (dev/staging/prod) with different sidecar endpoints.

---

## Usage Examples

### Interactive Development

#### Claude Agent
```bash
# Start container
docker compose up -d

# Attach to container (Ctrl+P, Ctrl+Q to detach without stopping)
docker attach claude-agent

# Inside container
$ claude
# Starts Claude Code CLI

# Or run a command
$ claude --print "Explain Docker"
```

#### Copilot Agent
```bash
docker run -it --rm \
  -e AGENT_TYPE=copilot \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -v $(pwd):/workspace \
  heretic-agent-copilot:latest

# Inside container
$ copilot suggest "implement user auth"
```

#### Gemini Agent
```bash
docker run -it --rm \
  -e AGENT_TYPE=gemini \
  -e GOOGLE_API_KEY=$GOOGLE_API_KEY \
  -v $(pwd):/workspace \
  heretic-agent-gemini:latest

# Inside container
$ gemini code chat
```

### Running a Prompt File

#### Claude
```bash
# Create a prompt
echo "Review this code for bugs" > workspace/prompt.txt

# Run with prompt
docker run -i --rm \
  -e AGENT_TYPE=claude \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e PROMPT_FILE=/workspace/prompt.txt \
  -e REPO_PATH=/workspace \
  -v $(pwd)/workspace:/workspace \
  --entrypoint /home/agent/entrypoint.sh \
  heretic-agent:latest
```

#### OpenCode
```bash
docker run -i --rm \
  -e AGENT_TYPE=opencode \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e PROMPT_FILE=/workspace/prompt.txt \
  -v $(pwd)/workspace:/workspace \
  --entrypoint /home/agent/entrypoint.sh \
  heretic-agent-opencode:latest
```

### Building a Project

```bash
# With built-in tools (Claude)
docker run -it --rm \
  -e AGENT_TYPE=claude \
  -v $(pwd)/myproject:/workspace \
  -w /workspace \
  heretic-agent:latest \
  bash -c "npm install && npm run build"

# With sidecars (any agent)
docker run -it --rm \
  -e AGENT_TYPE=claude \
  -e BUILD_SIDECARS='{"node":{"internal_url":"http://host.docker.internal:8080"}}' \
  -v $(pwd)/myproject:/workspace \
  heretic-agent:latest \
  bash -c "npm install && npm run build"
```

### Testing with Different Agents

#### Separate Images
```bash
# Claude with Z.AI backend
docker run -it --rm \
  -e AGENT_TYPE=claude \
  -e ANTHROPIC_API_KEY=$ZAI_TOKEN \
  -e ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic \
  heretic-agent:latest

# Gemini
docker run -it --rm \
  -e AGENT_TYPE=gemini \
  -e GOOGLE_API_KEY=$GOOGLE_API_KEY \
  heretic-agent-gemini:latest

# Copilot
docker run -it --rm \
  -e AGENT_TYPE=copilot \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  heretic-agent-copilot:latest
```

#### Combined Image (One Image, Multiple Agents)
```bash
# Build once
./build-heretic-agent \
  --agent claude --agent copilot --agent gemini \
  --combined \
  --name heretic-fat

# Test Claude
docker run -it --rm \
  -e AGENT_TYPE=claude \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  heretic-fat:latest

# Test Copilot (same image!)
docker run -it --rm \
  -e AGENT_TYPE=copilot \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  heretic-fat:latest

# Test Gemini (same image!)
docker run -it --rm \
  -e AGENT_TYPE=gemini \
  -e GOOGLE_API_KEY=$GOOGLE_API_KEY \
  heretic-fat:latest
```

---

## Included Tools

### Always Included

These tools are included in **all** Heretic Agent images by default:

| Tool | Description | Version |
|------|-------------|---------|
| **vim** | Text editor | 8.2+ |
| **git** | Version control | Latest |
| **curl** | HTTP client | Latest |
| **jq** | JSON processor | Latest |
| **ssh** | SSH client (openssh-client) | Latest |
| **ca-certificates** | SSL/TLS certificates | Latest |

### Python Tools (with `--with-python` or `--python-version`)

| Tool | Description | Version Control |
|------|-------------|-----------------|
| **python** | Python interpreter | `--python-version 3.11\|3.12\|3.13` (default: 3.13) |
| **pip** | Package installer (via get-pip.py) | - |
| **poetry** | Dependency management | Latest |
| **pytest** | Testing framework | Latest |
| **black** | Code formatter | Latest |
| **ruff** | Fast linter | Latest |
| **mypy** | Type checker | Latest |

**Default Python version**: 3.13 (from deadsnakes PPA)

### Node.js Tools (with `--with-node` or `--node-version`)

| Tool | Description | Version Control |
|------|-------------|-----------------|
| **node** | Node.js runtime | `--node-version 18\|20\|22` (default: 22) |
| **npm** | Package manager | Bundled with Node.js |
| **yarn** | Package manager (via corepack) | Managed by corepack |
| **pnpm** | Package manager (via corepack) | Managed by corepack |

**Important:** Node.js is **automatically installed** for non-node base images (required for agent CLIs). For `node:*` base images, version is determined by the base image tag.

### Go Tools (with `--with-go` or `--go-version`)

| Tool | Description | Version Control |
|------|-------------|-----------------|
| **go** | Go compiler | `--go-version 1.21.5\|1.22.0\|1.23.4` (default: 1.23.4) |
| **gofmt** | Go formatter | Bundled with Go |

**Default Go version**: 1.23.4

### Java Tools (with `--with-java` or `--java-version`)

| Tool | Description | Version Control |
|------|-------------|-----------------|
| **java** | Java (Eclipse Temurin) | `--java-version 11\|17\|21` (default: 21) |
| **mvn** | Maven build tool | 3.9.6 (fixed) |
| **gradle** | Gradle build tool | 8.5 (fixed) |

**Default Java version**: 21 (LTS)

### Rust Tools (with `--with-rust` or `--rust-version`)

| Tool | Description | Version Control |
|------|-------------|-----------------|
| **cargo** | Rust package manager | `--rust-version stable\|nightly\|beta\|1.75` (default: stable) |
| **rustc** | Rust compiler | Managed by rustup |
| **rustfmt** | Rust formatter | Installed as component |
| **clippy** | Rust linter | Installed as component |

**Default Rust version**: stable

### Docker Tools (with `--with-docker`)

| Tool | Description |
|------|-------------|
| **docker** | Docker CLI |
| **docker-compose** | Docker Compose plugin |

**Note:** Only includes CLI tools. Requires Docker socket mount or DinD for functionality.

### GitHub CLI (enabled by default)

| Tool | Description |
|------|-------------|
| **gh** | GitHub CLI for repo/PR/issue management |

### Locale Support (Ubuntu Base Images Only)

When using Ubuntu base images (e.g., `--base ubuntu:22.04`), the following locales are configured:

- **LANG**: `en_US.UTF-8`
- **LANGUAGE**: `en_US:en`
- **LC_ALL**: `en_US.UTF-8`

**Generated locale**: `en_US.UTF-8`

This ensures proper handling of Unicode characters in terminal output and file operations.

### Tool Backend Options

| Backend | Description | When to Use |
|---------|-------------|-------------|
| **Built-in** | Tools installed in image | Local dev, small images (<2GB OK) |
| **Sidecar** | Tools via HTTP (BUILD_SIDECARS) | CI/CD, slim images, shared tools |
| **SSH** | Tools via SSH (SSH_HOST) | Remote dev environments, security isolation |

---

## Troubleshooting

### Container Exits Immediately

```bash
# Check logs
docker logs claude-agent

# Run with interactive mode to debug
docker run -it --rm heretic-agent:latest /bin/bash
```

### Wrong Agent Type

```bash
# Verify AGENT_TYPE is set correctly
docker exec claude-agent env | grep AGENT_TYPE

# Check which CLI is available
docker exec claude-agent bash -c "command -v claude || command -v copilot || command -v gemini || command -v opencode"
```

### Permission Denied on Workspace

```bash
# Fix ownership
sudo chown -R 1000:1000 ./workspace

# Or run with user override
docker run -it --rm \
  --user $(id -u):$(id -g) \
  -v $(pwd)/workspace:/workspace \
  heretic-agent:latest
```

### Agent Settings Not Loading

```bash
# Claude settings
docker exec claude-agent cat /home/agent/.claude/settings.json

# OpenCode settings
docker exec opencode-agent cat /home/agent/.config/opencode/config.json

# Check HERETIC_DIR
docker exec claude-agent ls -la /workspace/.heretic/
```

### Sidecar Commands Not Found

```bash
# Verify BUILD_SIDECARS is set
docker exec claude-agent env | grep BUILD_SIDECARS

# Check sidecar health
docker exec claude-agent curl http://python-sidecar:8080/health

# Check generated wrappers
docker exec claude-agent ls /opt/sidecar/wrappers/
```

### SSH Backend Not Working

```bash
# Verify SSH_HOST is set
docker exec claude-agent env | grep SSH_HOST

# Test SSH connectivity
docker exec claude-agent ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
    ${SSH_USER:-agent}@${SSH_HOST} echo "connected"

# Check SSH key permissions
docker exec claude-agent ls -la /home/agent/.ssh/id_rsa
```

### Docker Commands Fail (DinD)

```bash
# Verify socket mount
docker run -it --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  heretic-agent:latest \
  docker ps

# Check permissions on socket
ls -la /var/run/docker.sock
```

### API Key Issues

```bash
# Claude - verify ANTHROPIC_API_KEY
docker exec claude-agent bash -c 'echo $ANTHROPIC_API_KEY | head -c 10'

# Copilot - verify GITHUB_TOKEN
docker exec copilot-agent bash -c 'echo $GITHUB_TOKEN | head -c 10'

# Gemini - verify GOOGLE_API_KEY
docker exec gemini-agent bash -c 'echo $GOOGLE_API_KEY | head -c 10'
```

### MCP Connection Issues

```bash
# Test MCP server from inside container
docker exec -it claude-agent /bin/bash
$ curl http://mcp-server:8080/health

# Verify MCP config
docker exec claude-agent cat /workspace/.mcp.json
```

### Combined Image: Wrong Agent Running

```bash
# Verify AGENT_TYPE is set correctly
docker exec heretic-agent env | grep AGENT_TYPE

# Check which agent CLIs are installed
docker exec heretic-agent bash -c "command -v claude && echo 'Claude installed'"
docker exec heretic-agent bash -c "command -v copilot && echo 'Copilot installed'"

# Recreate container with correct AGENT_TYPE
docker compose down
AGENT_TYPE=copilot docker compose up -d
```

### Python Version Issues

```bash
# Check Python version
docker exec agent python --version

# Verify Python tools are installed
docker exec agent pip --version
docker exec agent poetry --version
docker exec agent pytest --version

# If wrong version, rebuild with specific version
./build-heretic-agent --python-version 3.12
```

### Locale Issues (Ubuntu)

```bash
# Verify locale is configured
docker exec agent locale

# Check locale generation
docker exec agent locale -a | grep en_US

# Test Unicode handling
docker exec agent python3 -c "print('测试 Unicode 👍')"
```

### Vim Not Working

```bash
# Verify vim is installed (should always be present)
docker exec agent which vim

# Test vim
docker exec agent vim --version

# If missing, verify image was built correctly
docker run --rm agent:latest vim --version
```

---

## Tips

1. **Use combined mode for flexibility**: Build one image with `--combined` instead of multiple separate images:
   ```bash
   # Instead of multiple images:
   ./build-heretic-agent --agent claude --agent copilot

   # Use combined mode (one image):
   ./build-heretic-agent --agent claude --agent copilot --combined
   ```
   Benefits: Smaller disk usage, easier deployment, runtime agent selection.

2. **Use volumes for persistence**: Always mount a workspace volume to keep files between container restarts

3. **Python version control**: Specify Python version for your project needs:
   ```bash
   # Python 3.13 (default, recommended)
   ./build-heretic-agent --with-python

   # Python 3.12 for compatibility
   ./build-heretic-agent --python-version 3.12
   ```

4. **Vim is always available**: All images include vim text editor for quick edits:
   ```bash
   docker exec -it agent vim /workspace/file.py
   ```

5. **Locale support**: Ubuntu base images automatically configure `en_US.UTF-8` locale for proper Unicode handling

6. **Agent-specific settings**: Each agent type has different configuration requirements:
   - **Claude**: Mount `claude-settings.json` to configure permissions
   - **OpenCode**: Mount `opencode.json` for configuration
   - **Copilot/Gemini**: Use environment variables only

7. **Settings file examples**:

   **Claude** (`claude-settings.json`):
   ```json
   {
     "enabledMcpjsonServers": ["trello", "github"],
     "dangerouslySkipPermissions": true
   }
   ```

   **OpenCode** (`opencode.json`):
   ```json
   {
     "apiKey": "sk-ant-...",
     "model": "claude-3-opus"
   }
   ```

8. **Slim images**: For CI/CD, build without `--with-*` tool flags and use `BUILD_SIDECARS` or `SSH_HOST` at runtime

9. **Caching**: Docker layer caching works best when you build images with the same base and tool flags

10. **Debugging**: Use `docker exec` to get a shell in a running container without disrupting the main process

11. **Multi-agent workflows**: Run multiple agent types side-by-side for different tasks:
    - Claude for code review
    - Copilot for code suggestions
    - Gemini for documentation
    - OpenCode for general tasks

12. **BUILD_SIDECARS runtime configuration**: Always set `BUILD_SIDECARS` at runtime (via `-e` or docker-compose), never bake it into the image. This keeps images portable across environments.

13. **Base image selection**:
    - `ubuntu:22.04`: Full terminal environment, includes locale support (recommended for local dev)
    - `node:22-bookworm-slim`: Minimal Debian, smaller size (recommended for CI/CD)
    - `debian:bookworm-slim`: Middle ground between Ubuntu and Node slim

14. **Image naming with combined mode**:
    - Without `--combined`: `heretic-agent-<type>:latest` (e.g., `heretic-agent-copilot:latest`)
    - With `--combined`: Single image name (e.g., `heretic-agent:latest` or custom via `--name`)

---

## Image Size Reference

Approximate image sizes for different configurations:

| Configuration | Base Image | Tools | Agents | Size |
|---------------|------------|-------|--------|------|
| Minimal | node:22-bookworm-slim | GitHub CLI only | Claude | ~450MB |
| Standard | ubuntu:22.04 | Python 3.13, Node, Docker CLI, GitHub CLI | Claude | ~1.2GB |
| Combined | ubuntu:22.04 | Python 3.13, Node, Docker CLI, GitHub CLI | Claude + Copilot | ~1.5GB |
| Fat | ubuntu:22.04 | All tools | All 4 agents | ~2.0GB |

**Optimization Tips:**
- Use `node:*-slim` or `debian:*-slim` base images for smaller size
- Build without `--with-*` flags and use sidecars/SSH for tools
- Use combined mode to share base layers across multiple agents
- Enable Docker layer caching in CI/CD

---

## Additional Resources

- **README.md**: Full build script documentation and command-line reference
- **MIGRATION.md**: Migration guide from `build-claude-image` to `build-heretic-agent`
- **CHANGELOG.md**: Detailed changelog with version 2.0.0 features
- **orchestrator-service/AGENTS.md**: Integration with orchestrator service
- **Build script help**: Run `./build-heretic-agent --help` for full options

### Quick Reference Cards

**Combined Mode Quick Reference:**
```bash
# Build
./build-heretic-agent --agent claude --agent copilot --combined -n my-image

# Run
docker run -e AGENT_TYPE=claude -e ANTHROPIC_API_KEY=$KEY my-image:latest
docker run -e AGENT_TYPE=copilot -e GITHUB_TOKEN=$TOKEN my-image:latest
```

**Python Version Quick Reference:**
```bash
# Python 3.13 (default)
./build-heretic-agent --with-python

# Python 3.12
./build-heretic-agent --python-version 3.12

# Python 3.11
./build-heretic-agent --python-version 3.11
```

**Multi-Arch Quick Reference:**
```bash
# Current platform (default)
./build-heretic-agent --agent claude

# ARM64 (Apple Silicon)
./build-heretic-agent --agent claude --arch arm64

# Both AMD64 and ARM64
./build-heretic-agent --agent claude --arch both
```
