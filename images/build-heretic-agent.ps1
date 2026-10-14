<#
.SYNOPSIS
    Build Heretic Agent Docker image with configurable tools and agent types.

.DESCRIPTION
    Windows-native PowerShell equivalent of the bash build-heretic-agent script.
    Generates Dockerfiles dynamically and builds agent images.

.EXAMPLE
    .\build-heretic-agent.ps1 -Agent claude
    .\build-heretic-agent.ps1 -Agent copilot,gemini
    .\build-heretic-agent.ps1 -Agent all -WithAll -DryRun
    .\build-heretic-agent.ps1 -Agent claude,copilot -Combined -WithPython

.NOTES
    Requires Docker Desktop for Windows.
#>

[CmdletBinding()]
param(
    # Agent types (claude, copilot, opencode, gemini, all)
    [string[]]$Agent = @("claude"),

    # Combined mode - all agents in one image
    [switch]$Combined,

    # Image settings
    [Alias("n")]
    [string]$Name = $( if ($env:IMAGE_NAME) { $env:IMAGE_NAME } else { "heretic-agent" } ),

    [Alias("t")]
    [string]$Tag = $( if ($env:IMAGE_TAG) { $env:IMAGE_TAG } else { "latest" } ),

    [Alias("r")]
    [string]$Registry = $( if ($env:REGISTRY) { $env:REGISTRY } else { "" } ),

    [Alias("p")]
    [switch]$Push,

    [switch]$NoCache,
    [switch]$DryRun,

    # Architecture: amd64, arm64, both
    [Alias("a")]
    [string]$Arch = "",

    # Base image
    [string]$Base = $( if ($env:BASE_IMAGE) { $env:BASE_IMAGE } else { "node:22-bookworm-slim" } ),

    # Tool flags
    [switch]$WithPython,
    [string]$PythonVersion = "3.13",
    [switch]$WithNode,
    [string]$NodeVersion = "22",
    [switch]$WithGo,
    [string]$GoVersion = "1.23.4",
    [switch]$WithJava,
    [string]$JavaVersion = "21",
    [switch]$WithRust,
    [string]$RustVersion = "stable",
    [switch]$WithDocker,
    [switch]$WithGithubCli,
    [switch]$WithAll,

    # Agent user
    [string]$AgentUser = "agent",
    [int]$AgentUid = 1000,
    [int]$AgentGid = 1000
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DefaultBaseImage = "node:22-bookworm-slim"

# =============================================================================
# Initialization
# =============================================================================

# Default: GitHub CLI enabled
if (-not $WithGithubCli.IsPresent -and -not $WithAll.IsPresent) {
    $WithGithubCli = $true
}

# --with-all enables everything
if ($WithAll) {
    $WithPython = $true
    $WithNode = $true
    $WithGo = $true
    $WithJava = $true
    $WithRust = $true
    $WithDocker = $true
    $WithGithubCli = $true
}

# If version flags were explicitly passed, auto-enable the tool
if ($PSBoundParameters.ContainsKey('PythonVersion')) { $WithPython = $true }
if ($PSBoundParameters.ContainsKey('NodeVersion')) { $WithNode = $true }
if ($PSBoundParameters.ContainsKey('GoVersion')) { $WithGo = $true }
if ($PSBoundParameters.ContainsKey('JavaVersion')) { $WithJava = $true }
if ($PSBoundParameters.ContainsKey('RustVersion')) { $WithRust = $true }

# =============================================================================
# Agent Type Resolution
# =============================================================================

$ValidAgents = @("claude", "copilot", "opencode", "gemini")
$ExpandedAgents = @()

foreach ($a in $Agent) {
    $a = $a.ToLower().Trim()
    if ($a -eq "all") {
        $ExpandedAgents += $ValidAgents
    }
    elseif ($ValidAgents -contains $a) {
        $ExpandedAgents += $a
    }
    else {
        Write-Error "Invalid agent type '$a'. Use: claude, copilot, opencode, gemini, or all"
        exit 1
    }
}

$AgentTypes = $ExpandedAgents | Sort-Object -Unique

# =============================================================================
# Helper Functions
# =============================================================================

function Get-AgentNpmPackages {
    param([string]$AgentType)
    switch ($AgentType) {
        "claude"   { @("@anthropic-ai/claude-code", "mcp-remote") }
        "copilot"  { @("@github/copilot") }
        "opencode" { @("opencode-ai") }
        "gemini"   { @("@google/gemini-cli", "mcp-remote") }
    }
}

function Get-FullImageName {
    param(
        [string]$AgentType,
        [bool]$CombinedMode
    )
    $imgName = $Name
    if (-not $CombinedMode -and $AgentType -ne "claude") {
        $imgName = "$Name-$AgentType"
    }
    $fullTag = "${imgName}:${Tag}"
    if ($Registry) { return "$Registry/$fullTag" }
    return $fullTag
}

function Get-Platforms {
    switch ($Arch) {
        { $_ -in "amd64", "x86_64" } { "linux/amd64" }
        { $_ -in "arm64", "aarch64" } { "linux/arm64" }
        { $_ -in "both", "all" } { "linux/amd64,linux/arm64" }
        default { "" }
    }
}

# =============================================================================
# Dockerfile Generation
# =============================================================================

function New-Dockerfile {
    param(
        [string]$AgentType,
        [bool]$CombinedMode
    )

    $agents = if ($CombinedMode) { $AgentTypes } else { @($AgentType) }
    $agentLabel = if ($CombinedMode) { $agents -join "+" } else { $AgentType }

    $df = [System.Text.StringBuilder]::new()
    $null = $df.AppendLine("# Heretic Agent Image")
    $null = $df.AppendLine("# Auto-generated by build-heretic-agent.ps1")
    $null = $df.AppendLine("#")
    $null = $df.AppendLine("# Agent(s): $($agents -join ', ')")
    $null = $df.AppendLine("#")
    $null = $df.AppendLine("")

    # Base
    $null = $df.AppendLine("ARG BASE_IMAGE=$DefaultBaseImage")
    $null = $df.AppendLine('FROM ${BASE_IMAGE}')
    $null = $df.AppendLine("")
    $null = $df.AppendLine("ARG TARGETARCH")
    $null = $df.AppendLine("ARG AGENT_USER=$AgentUser")
    $null = $df.AppendLine("ARG AGENT_UID=$AgentUid")
    $null = $df.AppendLine("ARG AGENT_GID=$AgentGid")
    $null = $df.AppendLine("ARG AGENT_TYPE=$AgentType")
    $null = $df.AppendLine("")

    # Labels
    $null = $df.AppendLine("LABEL org.opencontainers.image.title=`"Heretic Agent ($agentLabel)`"")
    $null = $df.AppendLine("LABEL org.opencontainers.image.description=`"Unified agent with configurable tools (agent: $agentLabel)`"")
    $null = $df.AppendLine('LABEL org.opencontainers.image.vendor="Heretic"')
    $null = $df.AppendLine("")

    # ENV
    $null = $df.AppendLine("ENV DEBIAN_FRONTEND=noninteractive \")
    $null = $df.AppendLine("    PYTHONUNBUFFERED=1 \")
    $null = $df.AppendLine("    PYTHONDONTWRITEBYTECODE=1 \")
    $null = $df.AppendLine("    PIP_NO_CACHE_DIR=1 \")
    $null = $df.AppendLine("    PIP_DISABLE_PIP_VERSION_CHECK=1 \")
    $null = $df.AppendLine("    AGENT_TYPE=`"$AgentType`"")
    $null = $df.AppendLine("")

    # Base dependencies
    $null = $df.AppendLine("# Install base dependencies")
    $null = $df.AppendLine("RUN apt-get update && apt-get install -y --no-install-recommends \")
    $null = $df.AppendLine("    ca-certificates \")
    $null = $df.AppendLine("    curl \")
    $null = $df.AppendLine("    git \")
    $null = $df.AppendLine("    jq \")
    $null = $df.AppendLine("    xz-utils \")
    $null = $df.AppendLine("    gnupg \")
    $null = $df.AppendLine("    unzip \")
    $null = $df.AppendLine("    openssh-client \")
    $null = $df.AppendLine("    vim \")
    $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/*")
    $null = $df.AppendLine("")

    # Ubuntu locale
    if ($Base -match "^ubuntu:") {
        $null = $df.AppendLine("# Configure locales for Ubuntu")
        $null = $df.AppendLine("RUN apt-get update && apt-get install -y --no-install-recommends \")
        $null = $df.AppendLine("    locales \")
        $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/* \")
        $null = $df.AppendLine("    && locale-gen en_US.UTF-8 \")
        $null = $df.AppendLine("    && update-locale LANG=en_US.UTF-8")
        $null = $df.AppendLine("")
        $null = $df.AppendLine("ENV LANG=en_US.UTF-8 \")
        $null = $df.AppendLine("    LANGUAGE=en_US:en \")
        $null = $df.AppendLine("    LC_ALL=en_US.UTF-8")
        $null = $df.AppendLine("")
    }

    # Node.js
    if ($Base -match "^node:") {
        $null = $df.AppendLine("# Enable corepack for pnpm/yarn (Node base image)")
        $null = $df.AppendLine("RUN corepack enable")
        $null = $df.AppendLine("")
    }
    else {
        $null = $df.AppendLine("# Install Node.js ${NodeVersion}.x (required for agent CLIs)")
        $null = $df.AppendLine("RUN curl -fsSL https://deb.nodesource.com/setup_${NodeVersion}.x | bash - \")
        $null = $df.AppendLine("    && apt-get install -y nodejs \")
        $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/*")
        $null = $df.AppendLine("")
        $null = $df.AppendLine("# Enable corepack for pnpm/yarn")
        $null = $df.AppendLine("RUN corepack enable")
        $null = $df.AppendLine("")
    }

    # Python
    if ($WithPython) {
        if ($PythonVersion -and $PythonVersion -ne "default") {
            $null = $df.AppendLine("# Install Python $PythonVersion from deadsnakes PPA")
            $null = $df.AppendLine("RUN apt-get update && apt-get install -y --no-install-recommends \")
            $null = $df.AppendLine("    software-properties-common \")
            $null = $df.AppendLine("    curl \")
            $null = $df.AppendLine("    && add-apt-repository -y ppa:deadsnakes/ppa \")
            $null = $df.AppendLine("    && apt-get update \")
            $null = $df.AppendLine("    && apt-get install -y --no-install-recommends \")
            $null = $df.AppendLine("    python$PythonVersion \")
            $null = $df.AppendLine("    python${PythonVersion}-venv \")
            $null = $df.AppendLine("    python${PythonVersion}-dev \")
            $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/* \")
            $null = $df.AppendLine("    && ln -sf /usr/bin/python$PythonVersion /usr/bin/python3 \")
            $null = $df.AppendLine("    && ln -sf /usr/bin/python$PythonVersion /usr/bin/python \")
            $null = $df.AppendLine("    && curl -sS https://bootstrap.pypa.io/get-pip.py | python$PythonVersion")
            $null = $df.AppendLine("")
        }
        else {
            $null = $df.AppendLine("# Install Python 3 and tools (distro default)")
            $null = $df.AppendLine("RUN apt-get update && apt-get install -y --no-install-recommends \")
            $null = $df.AppendLine("    python3 \")
            $null = $df.AppendLine("    python3-pip \")
            $null = $df.AppendLine("    python3-venv \")
            $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/* \")
            $null = $df.AppendLine("    && ln -sf /usr/bin/python3 /usr/bin/python")
            $null = $df.AppendLine("")
        }

        $null = $df.AppendLine("# Install Python development tools")
        $null = $df.AppendLine("RUN pip3 install --break-system-packages --no-cache-dir \")
        $null = $df.AppendLine("    poetry \")
        $null = $df.AppendLine("    pytest \")
        $null = $df.AppendLine("    black \")
        $null = $df.AppendLine("    ruff \")
        $null = $df.AppendLine("    mypy \")
        $null = $df.AppendLine("    || pip3 install --no-cache-dir \")
        $null = $df.AppendLine("    poetry \")
        $null = $df.AppendLine("    pytest \")
        $null = $df.AppendLine("    black \")
        $null = $df.AppendLine("    ruff \")
        $null = $df.AppendLine("    mypy")
        $null = $df.AppendLine("")
    }

    # Go
    if ($WithGo) {
        $null = $df.AppendLine("# Install Go $GoVersion")
        $null = $df.AppendLine('RUN case "${TARGETARCH}" in \')
        $null = $df.AppendLine('        amd64) GO_ARCH="amd64" ;; \')
        $null = $df.AppendLine('        arm64) GO_ARCH="arm64" ;; \')
        $null = $df.AppendLine('        *) GO_ARCH="amd64" ;; \')
        $null = $df.AppendLine("    esac \")
        $null = $df.AppendLine("    && curl -fsSL `"https://go.dev/dl/go${GoVersion}.linux-`${GO_ARCH}.tar.gz`" \")
        $null = $df.AppendLine("    | tar -C /usr/local -xzf - \")
        $null = $df.AppendLine("    && ln -sf /usr/local/go/bin/go /usr/local/bin/go \")
        $null = $df.AppendLine("    && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt")
        $null = $df.AppendLine("")
        $null = $df.AppendLine('ENV PATH="/usr/local/go/bin:${PATH}"')
        $null = $df.AppendLine("")
    }

    # Java
    if ($WithJava) {
        $null = $df.AppendLine("# Install Java $JavaVersion (Eclipse Temurin)")
        $null = $df.AppendLine("RUN apt-get update && apt-get install -y --no-install-recommends \")
        $null = $df.AppendLine("    wget \")
        $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/*")
        $null = $df.AppendLine("")
        $null = $df.AppendLine('RUN case "${TARGETARCH}" in \')
        $null = $df.AppendLine('        amd64) JAVA_ARCH="x64" ;; \')
        $null = $df.AppendLine('        arm64) JAVA_ARCH="aarch64" ;; \')
        $null = $df.AppendLine('        *) JAVA_ARCH="x64" ;; \')
        $null = $df.AppendLine("    esac \")
        $null = $df.AppendLine("    && mkdir -p /opt/java \")
        $null = $df.AppendLine("    && cd /opt/java \")
        $null = $df.AppendLine("    && wget -q `"https://github.com/adoptium/temurin${JavaVersion}-binaries/releases/download/jdk-${JavaVersion}.0.2%2B13/OpenJDK${JavaVersion}U-jdk_`${JAVA_ARCH}_linux_hotspot_${JavaVersion}.0.2_13.tar.gz`" \")
        $null = $df.AppendLine("    && tar -xzf OpenJDK*.tar.gz \")
        $null = $df.AppendLine("    && rm OpenJDK*.tar.gz \")
        $null = $df.AppendLine("    && mv jdk* jdk \")
        $null = $df.AppendLine("    && ln -sf /opt/java/jdk/bin/* /usr/local/bin/")
        $null = $df.AppendLine("")
        $null = $df.AppendLine('ENV JAVA_HOME="/opt/java/jdk"')
        $null = $df.AppendLine('ENV PATH="${JAVA_HOME}/bin:${PATH}"')
        $null = $df.AppendLine("")
        $null = $df.AppendLine("# Install Maven 3.9.6")
        $null = $df.AppendLine('RUN curl -fsSL "https://dlcdn.apache.org/maven/maven-3/3.9.6/binaries/apache-maven-3.9.6-bin.tar.gz" \')
        $null = $df.AppendLine("    | tar -C /opt -xzf - \")
        $null = $df.AppendLine("    && ln -sf /opt/apache-maven-3.9.6/bin/mvn /usr/local/bin/mvn")
        $null = $df.AppendLine("")
        $null = $df.AppendLine("# Install Gradle 8.5")
        $null = $df.AppendLine('RUN curl -fsSL "https://services.gradle.org/distributions/gradle-8.5-bin.zip" -o /tmp/gradle.zip \')
        $null = $df.AppendLine("    && unzip -q /tmp/gradle.zip -d /opt \")
        $null = $df.AppendLine("    && rm /tmp/gradle.zip \")
        $null = $df.AppendLine("    && ln -sf /opt/gradle-8.5/bin/gradle /usr/local/bin/gradle")
        $null = $df.AppendLine("")
    }

    # Rust
    if ($WithRust) {
        $null = $df.AppendLine("# Install Rust $RustVersion")
        $null = $df.AppendLine("RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain $RustVersion")
        $null = $df.AppendLine('ENV PATH="/root/.cargo/bin:${PATH}"')
        $null = $df.AppendLine("RUN rustup component add rustfmt clippy")
        $null = $df.AppendLine("")
    }

    # Docker CLI
    if ($WithDocker) {
        $null = $df.AppendLine("# Install Docker CLI")
        $null = $df.AppendLine('RUN . /etc/os-release \')
        $null = $df.AppendLine('    && curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \')
        $null = $df.AppendLine("    | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \")
        $null = $df.AppendLine('    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \')
        $null = $df.AppendLine("    | tee /etc/apt/sources.list.d/docker.list > /dev/null \")
        $null = $df.AppendLine("    && apt-get update \")
        $null = $df.AppendLine("    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \")
        $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/*")
        $null = $df.AppendLine("")
    }

    # GitHub CLI
    if ($WithGithubCli) {
        $null = $df.AppendLine("# Install GitHub CLI")
        $null = $df.AppendLine("RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \")
        $null = $df.AppendLine("    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \")
        $null = $df.AppendLine('    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \')
        $null = $df.AppendLine("    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \")
        $null = $df.AppendLine("    && apt-get update \")
        $null = $df.AppendLine("    && apt-get install -y gh \")
        $null = $df.AppendLine("    && rm -rf /var/lib/apt/lists/*")
        $null = $df.AppendLine("")
    }

    # Agent CLI
    if ($CombinedMode) {
        $allPkgs = @()
        foreach ($a in $agents) {
            $allPkgs += Get-AgentNpmPackages -AgentType $a
        }
        $uniquePkgs = $allPkgs | Sort-Object -Unique
        $null = $df.AppendLine("# Install Agent CLIs (Combined Mode)")
        $null = $df.AppendLine("RUN npm install -g $($uniquePkgs -join ' ')")
        $null = $df.AppendLine("")
    }
    else {
        $pkgs = Get-AgentNpmPackages -AgentType $AgentType
        $null = $df.AppendLine("# Install $AgentType CLI")
        $null = $df.AppendLine("RUN npm install -g $($pkgs -join ' ')")
        $null = $df.AppendLine("")
    }

    # Tool backends
    $null = $df.AppendLine("# Tool backends - runtime wrapper generation in entrypoint.sh")
    $null = $df.AppendLine("COPY sidecar-exec /opt/sidecar/sidecar-exec")
    $null = $df.AppendLine("COPY ssh-exec /opt/sidecar/ssh-exec")
    $null = $df.AppendLine('RUN chmod +x /opt/sidecar/sidecar-exec /opt/sidecar/ssh-exec \')
    $null = $df.AppendLine("    && mkdir -p /opt/sidecar/wrappers")
    $null = $df.AppendLine('ENV PATH="/opt/sidecar/wrappers:${PATH}"')
    $null = $df.AppendLine("")

    # User creation
    $null = $df.AppendLine("# Create agent user")
    $null = $df.AppendLine('RUN (userdel -r node 2>/dev/null || true) \')
    $null = $df.AppendLine('    && groupadd -g ${AGENT_GID} ${AGENT_USER} \')
    $null = $df.AppendLine('    && useradd -m -s /bin/bash -u ${AGENT_UID} -g ${AGENT_GID} ${AGENT_USER}')
    $null = $df.AppendLine("")

    # Rust user setup
    if ($WithRust) {
        $null = $df.AppendLine("# Copy Rust installation for agent user")
        $null = $df.AppendLine('RUN cp -r /root/.cargo /home/${AGENT_USER}/.cargo \')
        $null = $df.AppendLine('    && cp -r /root/.rustup /home/${AGENT_USER}/.rustup 2>/dev/null || true \')
        $null = $df.AppendLine('    && chown -R ${AGENT_USER}:${AGENT_USER} /home/${AGENT_USER}/.cargo \')
        $null = $df.AppendLine('    && echo ''export PATH="/home/${AGENT_USER}/.cargo/bin:${PATH}"'' >> /home/${AGENT_USER}/.bashrc')
        $null = $df.AppendLine("")
    }

    # Directories
    if ($CombinedMode) {
        $null = $df.AppendLine("# Setup directories for all agents (Combined Mode)")
        $null = $df.AppendLine('RUN mkdir -p /workspace /home/${AGENT_USER}/.claude /home/${AGENT_USER}/.config/opencode /home/${AGENT_USER}/.gemini \')
        $null = $df.AppendLine('    && chown -R ${AGENT_USER}:${AGENT_USER} /home/${AGENT_USER} /workspace')
    }
    else {
        $dirMap = @{
            "claude"   = '/home/${AGENT_USER}/.claude /workspace'
            "copilot"  = "/workspace"
            "opencode" = '/home/${AGENT_USER}/.config/opencode /workspace'
            "gemini"   = '/home/${AGENT_USER}/.gemini /workspace'
        }
        $null = $df.AppendLine("# Setup $AgentType-specific directories")
        $null = $df.AppendLine("RUN mkdir -p $($dirMap[$AgentType]) \")
        $null = $df.AppendLine('    && chown -R ${AGENT_USER}:${AGENT_USER} /home/${AGENT_USER} /workspace')
    }
    $null = $df.AppendLine("")

    $null = $df.AppendLine('USER ${AGENT_USER}')
    $null = $df.AppendLine('WORKDIR /home/${AGENT_USER}')
    $null = $df.AppendLine("")

    # Runtime env
    $null = $df.AppendLine("# Runtime environment variables")
    $null = $df.AppendLine('ENV API_TIMEOUT_MS="3000000"')
    $null = $df.AppendLine('ENV GH_TOKEN=""')
    $null = $df.AppendLine('ENV TASK_ID=""')
    $null = $df.AppendLine('ENV STEP_NAME=""')
    $null = $df.AppendLine('ENV REPO_PATH="/workspace"')
    $null = $df.AppendLine('ENV PROMPT_FILE=""')
    $null = $df.AppendLine('ENV AGENT_ARGS=""')
    $null = $df.AppendLine('ENV AGENT_OUTPUT_FORMAT="stream-json"')
    $null = $df.AppendLine("")

    $null = $df.AppendLine("# Default command - interactive shell")
    $null = $df.AppendLine('CMD ["/bin/bash"]')

    return $df.ToString()
}

# =============================================================================
# Build Function
# =============================================================================

function Build-Agent {
    param(
        [string]$AgentType,
        [bool]$CombinedMode
    )

    $fullName = Get-FullImageName -AgentType $AgentType -CombinedMode $CombinedMode
    $label = if ($CombinedMode) { $AgentTypes -join ", " } else { $AgentType }

    Write-Host ""
    Write-Host "=== Building $label Agent ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Configuration:"
    Write-Host "  Agent type(s):  $label"
    Write-Host "  Image name:     $fullName"
    Write-Host "  Base image:     $Base"
    Write-Host "  Architecture:   $(if ($Arch) { $Arch } else { 'current platform' })"
    Write-Host "  Push:           $Push"
    Write-Host ""
    Write-Host "Tools:"
    Write-Host "  Python:         $(if ($WithPython) { $PythonVersion } else { 'false' })"
    if ($Base -match "^node:") {
        Write-Host "  Node.js:        included in base"
    } else {
        Write-Host "  Node.js:        $(if ($WithNode) { "${NodeVersion}.x" } else { 'auto (required)' })"
    }
    Write-Host "  Go:             $(if ($WithGo) { $GoVersion } else { 'false' })"
    Write-Host "  Java:           $(if ($WithJava) { $JavaVersion } else { 'false' })"
    Write-Host "  Rust:           $(if ($WithRust) { $RustVersion } else { 'false' })"
    Write-Host "  Docker CLI:     $WithDocker"
    Write-Host "  GitHub CLI:     $WithGithubCli"
    Write-Host "  Tool backends:  sidecar-exec, ssh-exec (runtime wrappers)"
    Write-Host ""

    # Create temp build directory
    $buildDir = Join-Path ([System.IO.Path]::GetTempPath()) "heretic-build-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

    try {
        # Generate Dockerfile
        $dockerfile = New-Dockerfile -AgentType $AgentType -CombinedMode $CombinedMode
        Set-Content -Path (Join-Path $buildDir "Dockerfile") -Value $dockerfile -NoNewline

        # Copy entrypoint from existing file or generate
        $entrypointSrc = Join-Path $ScriptDir "entrypoint.sh"
        if (Test-Path $entrypointSrc) {
            Copy-Item $entrypointSrc (Join-Path $buildDir "entrypoint.sh")
        }

        # Copy sidecar-exec
        $realSidecar = Join-Path $ScriptDir ".." "build-sidecars" "client" "shell" "sidecar-exec"
        $stubSidecar = Join-Path $ScriptDir "resources" "sidecar-exec-stub"
        if (Test-Path $realSidecar) {
            Copy-Item $realSidecar (Join-Path $buildDir "sidecar-exec")
        }
        elseif (Test-Path $stubSidecar) {
            Copy-Item $stubSidecar (Join-Path $buildDir "sidecar-exec")
            Write-Warning "Using sidecar-exec stub. Real sidecar-exec not found."
        }
        else {
            Set-Content -Path (Join-Path $buildDir "sidecar-exec") -Value "#!/bin/bash`necho `"Error: sidecar-exec not available`" >&2`nexit 1`n"
        }

        # Copy ssh-exec
        $sshExecSrc = Join-Path $ScriptDir "resources" "ssh-exec"
        $sshExecFallback = Join-Path $ScriptDir "ssh-exec"
        if (Test-Path $sshExecSrc) {
            Copy-Item $sshExecSrc (Join-Path $buildDir "ssh-exec")
        }
        elseif (Test-Path $sshExecFallback) {
            Copy-Item $sshExecFallback (Join-Path $buildDir "ssh-exec")
        }

        # Dry run
        if ($DryRun) {
            Write-Host "=== Generated Dockerfile ===" -ForegroundColor Yellow
            Write-Host $dockerfile
            return
        }

        # Build
        $platforms = Get-Platforms
        $buildArgs = @(
            "--build-arg", "BASE_IMAGE=$Base"
            "--build-arg", "AGENT_USER=$AgentUser"
            "--build-arg", "AGENT_UID=$AgentUid"
            "--build-arg", "AGENT_GID=$AgentGid"
            "--build-arg", "AGENT_TYPE=$(if ($CombinedMode) { 'combined' } else { $AgentType })"
            "--tag", $fullName
        )

        if ($NoCache) { $buildArgs += "--no-cache" }

        Push-Location $buildDir
        try {
            if ($platforms) {
                $buildArgs += @("--platform", $platforms)
                if ($Push) {
                    Write-Host "Mode: buildx with push"
                    & docker buildx build @buildArgs --push -f Dockerfile .
                }
                else {
                    Write-Host "Mode: buildx local"
                    & docker buildx build @buildArgs --load -f Dockerfile .
                }
            }
            else {
                Write-Host "Mode: standard build (current platform)"
                & docker build @buildArgs -f Dockerfile .

                if ($Push -and $Registry) {
                    Write-Host "Pushing image..."
                    & docker push $fullName
                }
            }
        }
        finally {
            Pop-Location
        }

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Docker build failed with exit code $LASTEXITCODE"
            exit $LASTEXITCODE
        }

        Write-Host ""
        Write-Host "Build complete: $fullName" -ForegroundColor Green
        Write-Host ""
    }
    finally {
        Remove-Item -Path $buildDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# =============================================================================
# Main
# =============================================================================

Write-Host "=== Heretic Agent Image Builder (PowerShell) ===" -ForegroundColor Cyan
Write-Host ""

if ($Combined -and $AgentTypes.Count -gt 1) {
    Build-Agent -AgentType $AgentTypes[0] -CombinedMode $true

    $imgName = Get-FullImageName -AgentType $AgentTypes[0] -CombinedMode $true
    Write-Host "Usage examples:"
    foreach ($a in $AgentTypes) {
        Write-Host "  docker run -it --rm -e AGENT_TYPE=$a $imgName"
    }
    Write-Host ""
}
elseif ($AgentTypes.Count -gt 1) {
    Write-Host "Building $($AgentTypes.Count) agent types: $($AgentTypes -join ', ')"
    foreach ($a in $AgentTypes) {
        Write-Host ""
        Write-Host ("=" * 50)
        Build-Agent -AgentType $a -CombinedMode $false
        Write-Host ("=" * 50)
        Write-Host ""
    }
    Write-Host "All $($AgentTypes.Count) agent images built successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Built images:"
    foreach ($a in $AgentTypes) {
        Write-Host "  - $(Get-FullImageName -AgentType $a -CombinedMode $false)"
    }
}
else {
    $agent = $AgentTypes[0]
    Build-Agent -AgentType $agent -CombinedMode $false

    $imgName = Get-FullImageName -AgentType $agent -CombinedMode $false
    Write-Host "Usage examples:"
    Write-Host "  # Interactive mode"
    Write-Host "  docker run -it --rm $imgName"
    Write-Host ""
    Write-Host "  # Workflow mode"
    Write-Host "  docker run -it --rm ``"
    Write-Host "    -e PROMPT_FILE=/workspace/prompt.md ``"
    Write-Host "    -e REPO_PATH=/workspace ``"
    Write-Host "    -v `${PWD}:/workspace ``"
    Write-Host "    --entrypoint /home/agent/entrypoint.sh ``"
    Write-Host "    $imgName"
    Write-Host ""
}
