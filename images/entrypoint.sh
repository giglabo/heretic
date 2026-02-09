#!/bin/bash
#
# Universal Entrypoint for Heretic Agent
#
# Handles setup for all three use cases:
# 1. User interactive: docker run -it image → starts bash
# 2. User one-shot: docker run image claude --help → runs claude directly
# 3. Orchestrator: command=["claude", "--print", ...] → runs as specified
#

set -e

# =============================================================================
# Setup (runs for all modes)
# =============================================================================

# =============================================================================
# Runtime Tool Wrappers
# =============================================================================
# Detects available backends (fat/local, sidecar, SSH) and generates
# tool wrappers at container start. Priority: fat > sidecar > SSH.

setup_tool_wrappers() {
    # Runtime → commands mapping
    declare -A RUNTIME_COMMANDS=(
        [node]="npm npx pnpm yarn node"
        [python]="python python3 pip pip3 poetry pytest ruff black mypy"
        [java]="java javac mvn gradle"
        [go]="go gofmt"
        [rust]="cargo rustc rustfmt clippy"
    )

    local WRAPPER_DIR="/opt/sidecar/wrappers"

    # Clean slate
    if [[ -d "$WRAPPER_DIR" ]]; then
        rm -f "$WRAPPER_DIR"/*
    else
        mkdir -p "$WRAPPER_DIR"
    fi

    # Parse BUILD_SIDECARS runtimes (if set)
    declare -A SIDECAR_RUNTIMES=()
    if [[ -n "${BUILD_SIDECARS:-}" ]] && [[ "$BUILD_SIDECARS" != "{}" ]]; then
        while IFS= read -r rt; do
            [[ -n "$rt" ]] && SIDECAR_RUNTIMES["$rt"]=1
        done < <(echo "$BUILD_SIDECARS" | jq -r 'keys[]' 2>/dev/null || true)
    fi

    local has_ssh="false"
    [[ -n "${SSH_HOST:-}" ]] && has_ssh="true"

    # Nothing to do if no backends configured
    if [[ ${#SIDECAR_RUNTIMES[@]} -eq 0 ]] && [[ "$has_ssh" == "false" ]]; then
        return 0
    fi

    local wrapper_count=0

    for runtime in "${!RUNTIME_COMMANDS[@]}"; do
        for cmd in ${RUNTIME_COMMANDS[$runtime]}; do
            # Skip if binary exists natively (check PATH excluding wrapper dir)
            local clean_path
            clean_path=$(echo "$PATH" | tr ':' '\n' | grep -v "$WRAPPER_DIR" | tr '\n' ':' | sed 's/:$//')
            if PATH="$clean_path" command -v "$cmd" >/dev/null 2>&1; then
                continue
            fi

            # Try sidecar backend
            if [[ -n "${SIDECAR_RUNTIMES[$runtime]+x}" ]]; then
                cat > "$WRAPPER_DIR/$cmd" <<WRAPPER
#!/bin/bash
exec /opt/sidecar/sidecar-exec "$runtime" "$cmd" "\$@"
WRAPPER
                chmod +x "$WRAPPER_DIR/$cmd"
                wrapper_count=$((wrapper_count + 1))
                continue
            fi

            # Try SSH backend
            if [[ "$has_ssh" == "true" ]]; then
                cat > "$WRAPPER_DIR/$cmd" <<WRAPPER
#!/bin/bash
exec /opt/sidecar/ssh-exec "$cmd" "\$@"
WRAPPER
                chmod +x "$WRAPPER_DIR/$cmd"
                wrapper_count=$((wrapper_count + 1))
                continue
            fi
        done
    done

    if [[ $wrapper_count -gt 0 ]]; then
        echo "Tool wrappers: $wrapper_count commands configured"
    fi
}

setup_tool_wrappers

# Configure git credentials if GH_TOKEN provided
if [[ -n "${GH_TOKEN:-}" ]]; then
    git config --global credential.helper store
    echo "https://x-access-token:${GH_TOKEN}@github.com" > ~/.git-credentials
fi

# Set git user info
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@example.com}"
git config --global user.name "${GIT_AUTHOR_NAME:-Heretic Agent}"

# Configure git hooks if available
for hooks_path in "${REPO_PATH:-/workspace}/.githooks" "/workspace/.githooks"; do
    if [[ -d "$hooks_path" ]]; then
        git config --global core.hooksPath "$hooks_path"
        break
    fi
done

# Setup Claude settings if provided
CLAUDE_SETTINGS_SOURCE="${HERETIC_DIR:-/workspace/.heretic}/claude-settings.json"
if [[ -f "$CLAUDE_SETTINGS_SOURCE" ]]; then
    mkdir -p ~/.claude
    cp "$CLAUDE_SETTINGS_SOURCE" ~/.claude/settings.json
fi

# =============================================================================
# Execute
# =============================================================================

# If no arguments provided, default to interactive shell
if [[ $# -eq 0 ]]; then
    exec /bin/bash
fi

# Otherwise, execute the provided command (claude or anything else)
cd "${REPO_PATH:-/workspace}"
exec "$@"
