# Building Heretic Agent Images on Windows

Three ways to build Heretic Agent Docker images on Windows, depending on your setup.

## Prerequisites

- **Docker Desktop for Windows** (with WSL2 backend recommended)
- At least one of:
  - PowerShell 5.1+ (included in Windows 10/11)
  - [Bun](https://bun.sh) runtime
  - WSL2 or Git Bash

---

## Option 1: PowerShell (Recommended for Windows)

Native Windows experience. No extra tools required.

### Basic Usage

```powershell
# Build Claude agent (default)
.\build-heretic-agent.ps1

# Build specific agent type
.\build-heretic-agent.ps1 -Agent copilot

# Build multiple agents (separate images)
.\build-heretic-agent.ps1 -Agent claude,copilot

# Build multiple agents in ONE image (combined)
.\build-heretic-agent.ps1 -Agent claude,copilot -Combined

# Build all agent types
.\build-heretic-agent.ps1 -Agent all
```

### With Tools

```powershell
# With Python and Docker CLI
.\build-heretic-agent.ps1 -WithPython -WithDocker

# With specific Python version
.\build-heretic-agent.ps1 -PythonVersion 3.12

# With all tools
.\build-heretic-agent.ps1 -WithAll

# Combined image with tools
.\build-heretic-agent.ps1 -Agent claude,copilot -Combined -WithPython -WithDocker
```

### Advanced Options

```powershell
# Custom image name and tag
.\build-heretic-agent.ps1 -Name my-agent -Tag v1.0

# Use Ubuntu base (recommended for local development)
.\build-heretic-agent.ps1 -Base ubuntu:22.04 -WithPython -WithDocker

# Dry run (print Dockerfile without building)
.\build-heretic-agent.ps1 -DryRun

# Build and push to registry
.\build-heretic-agent.ps1 -Push -Registry ghcr.io/myorg

# Multi-arch build
.\build-heretic-agent.ps1 -Arch both -Push -Registry ghcr.io/myorg

# ARM64 build (for Apple Silicon targets)
.\build-heretic-agent.ps1 -Arch arm64
```

### Execution Policy

If you get a script execution error, run:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### PowerShell vs Bash Parameter Mapping

| Bash | PowerShell | Example |
|------|-----------|---------|
| `--agent claude` | `-Agent claude` | `-Agent claude,copilot` |
| `--combined` | `-Combined` | (switch) |
| `-n, --name` | `-Name` | `-Name my-agent` |
| `-t, --tag` | `-Tag` | `-Tag v1.0` |
| `-r, --registry` | `-Registry` | `-Registry ghcr.io/org` |
| `-p, --push` | `-Push` | (switch) |
| `--no-cache` | `-NoCache` | (switch) |
| `--dry-run` | `-DryRun` | (switch) |
| `-a, --arch` | `-Arch` | `-Arch arm64` |
| `--base` | `-Base` | `-Base ubuntu:22.04` |
| `--with-python` | `-WithPython` | (switch) |
| `--python-version` | `-PythonVersion` | `-PythonVersion 3.12` |
| `--with-node` | `-WithNode` | (switch) |
| `--node-version` | `-NodeVersion` | `-NodeVersion 20` |
| `--with-go` | `-WithGo` | (switch) |
| `--go-version` | `-GoVersion` | `-GoVersion 1.22.0` |
| `--with-java` | `-WithJava` | (switch) |
| `--java-version` | `-JavaVersion` | `-JavaVersion 17` |
| `--with-rust` | `-WithRust` | (switch) |
| `--rust-version` | `-RustVersion` | `-RustVersion nightly` |
| `--with-docker` | `-WithDocker` | (switch) |
| `--with-github-cli` | `-WithGithubCli` | (switch) |
| `--with-all` | `-WithAll` | (switch) |
| `--agent-user` | `-AgentUser` | `-AgentUser dev` |
| `--agent-uid` | `-AgentUid` | `-AgentUid 1001` |
| `--agent-gid` | `-AgentGid` | `-AgentGid 1001` |

---

## Option 2: Bun / TypeScript (Cross-Platform)

Same script works on Windows, macOS, and Linux. Requires [Bun](https://bun.sh) installed.

### Install Bun on Windows

```powershell
# Using PowerShell
irm bun.sh/install.ps1 | iex

# Or using npm
npm install -g bun
```

### Usage

```powershell
# Build Claude agent (default)
bun images/build-heretic-agent.ts

# Build specific agent type
bun images/build-heretic-agent.ts --agent copilot

# Build multiple agents
bun images/build-heretic-agent.ts --agent claude --agent copilot

# Combined mode
bun images/build-heretic-agent.ts --agent claude --agent copilot --combined

# With tools
bun images/build-heretic-agent.ts --with-python --with-docker

# Dry run
bun images/build-heretic-agent.ts --dry-run

# Full example
bun images/build-heretic-agent.ts --agent claude --agent copilot --combined --with-python --with-docker --base ubuntu:22.04 --name heretic-local
```

The TypeScript script uses the exact same CLI flags as the bash version. See `bun images/build-heretic-agent.ts --help` for full options.

---

## Option 3: WSL2 / Git Bash

Run the original bash script directly. Works if you have WSL2 (recommended with Docker Desktop) or Git Bash installed.

### With WSL2

```bash
# From Windows Terminal or PowerShell
wsl bash images/build-heretic-agent --agent claude --with-python

# Or open WSL2 terminal first
wsl
cd /mnt/c/path/to/heretic
./images/build-heretic-agent --agent claude --with-python
```

### With Git Bash

```bash
# From Git Bash terminal
./images/build-heretic-agent --agent claude --with-python
```

---

## Running Built Images on Windows

Docker Desktop for Windows runs Linux containers via WSL2. All built images work the same way.

### Interactive Mode

```powershell
# PowerShell
docker run -it --rm `
  -e ANTHROPIC_API_KEY=$env:ANTHROPIC_API_KEY `
  -v ${PWD}:/workspace `
  heretic-agent:latest

# Or CMD
docker run -it --rm ^
  -e ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY% ^
  -v %cd%:/workspace ^
  heretic-agent:latest
```

### With Docker Socket (DooD)

Docker Desktop for Windows exposes the socket differently:

```powershell
# PowerShell - Docker Desktop exposes via named pipe
docker run -it --rm `
  -v //var/run/docker.sock:/var/run/docker.sock `
  -v ${PWD}:/workspace `
  heretic-agent:latest
```

### Combined Image

```powershell
# Use Claude
docker run -it --rm `
  -e AGENT_TYPE=claude `
  -e ANTHROPIC_API_KEY=$env:ANTHROPIC_API_KEY `
  heretic-agent:latest

# Use Copilot (same image)
docker run -it --rm `
  -e AGENT_TYPE=copilot `
  -e GITHUB_TOKEN=$env:GITHUB_TOKEN `
  heretic-agent:latest
```

---

## Troubleshooting

### Docker Desktop Not Running

```
Error: Cannot connect to the Docker daemon
```

Start Docker Desktop from the Start Menu or system tray.

### WSL2 Integration

Ensure Docker Desktop has WSL2 integration enabled:
1. Open Docker Desktop Settings
2. Go to Resources > WSL Integration
3. Enable integration with your WSL2 distro

### PowerShell Execution Policy

```
File cannot be loaded because running scripts is disabled
```

Fix:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Path Issues with Volume Mounts

Windows paths need special handling in Docker:

```powershell
# Use ${PWD} in PowerShell (not $(pwd))
docker run -v ${PWD}:/workspace heretic-agent:latest

# In CMD, use %cd%
docker run -v %cd%:/workspace heretic-agent:latest
```

### Long Path Support

If you encounter path length issues, enable long paths:

```powershell
# Run as Administrator
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
```

### Buildx Not Available

Multi-arch builds require Docker Buildx:

```powershell
# Check if buildx is available
docker buildx version

# Create a builder if needed
docker buildx create --name heretic-builder --use
```
