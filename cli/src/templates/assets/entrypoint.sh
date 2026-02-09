#!/bin/bash
#
# Universal Entrypoint for Heretic Agent
#
# Supports two modes:
# 1. Interactive mode (default): Starts a shell for local development
# 2. Workflow mode: Executes agent with prompt when PROMPT_FILE is set
#

set -e

# =============================================================================
# Runtime Tool Wrappers
# =============================================================================

setup_tool_wrappers() {
    declare -A RUNTIME_COMMANDS=(
        [node]="npm npx pnpm yarn node"
        [python]="python python3 pip pip3 poetry pytest ruff black mypy"
        [java]="java javac mvn gradle"
        [go]="go gofmt"
        [rust]="cargo rustc rustfmt clippy"
    )

    local WRAPPER_DIR="/opt/sidecar/wrappers"

    if [[ -d "$WRAPPER_DIR" ]]; then
        rm -f "$WRAPPER_DIR"/*
    else
        mkdir -p "$WRAPPER_DIR"
    fi

    declare -A SIDECAR_RUNTIMES=()
    if [[ -n "${BUILD_SIDECARS:-}" ]] && [[ "$BUILD_SIDECARS" != "{}" ]]; then
        while IFS= read -r rt; do
            [[ -n "$rt" ]] && SIDECAR_RUNTIMES["$rt"]=1
        done < <(echo "$BUILD_SIDECARS" | jq -r 'keys[]' 2>/dev/null || true)
    fi

    local has_ssh="false"
    [[ -n "${SSH_HOST:-}" ]] && has_ssh="true"

    if [[ ${#SIDECAR_RUNTIMES[@]} -eq 0 ]] && [[ "$has_ssh" == "false" ]]; then
        return 0
    fi

    local wrapper_count=0

    for runtime in "${!RUNTIME_COMMANDS[@]}"; do
        for cmd in ${RUNTIME_COMMANDS[$runtime]}; do
            local clean_path
            clean_path=$(echo "$PATH" | tr ':' '\n' | grep -v "$WRAPPER_DIR" | tr '\n' ':' | sed 's/:$//')
            if PATH="$clean_path" command -v "$cmd" >/dev/null 2>&1; then
                continue
            fi

            if [[ -n "${SIDECAR_RUNTIMES[$runtime]+x}" ]]; then
                cat > "$WRAPPER_DIR/$cmd" <<WRAPPER
#!/bin/bash
exec /opt/sidecar/sidecar-exec "$runtime" "$cmd" "\$@"
WRAPPER
                chmod +x "$WRAPPER_DIR/$cmd"
                wrapper_count=$((wrapper_count + 1))
                continue
            fi

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

# =============================================================================
# Mode Detection
# =============================================================================

if [[ -z "${PROMPT_FILE:-}" ]]; then
    echo "=== Heretic Agent (Interactive Mode) ==="
    echo "Agent type: ${AGENT_TYPE:-unknown}"
    echo "Tools available:"
    command -v python3 >/dev/null 2>&1 && echo "  - Python: $(python3 --version 2>&1 | head -1)"
    command -v node >/dev/null 2>&1 && echo "  - Node.js: $(node --version)"
    command -v go >/dev/null 2>&1 && echo "  - Go: $(go version)"
    command -v java >/dev/null 2>&1 && echo "  - Java: $(java -version 2>&1 | head -1)"
    command -v rustc >/dev/null 2>&1 && echo "  - Rust: $(rustc --version)"
    command -v docker >/dev/null 2>&1 && echo "  - Docker CLI: $(docker --version)"
    command -v gh >/dev/null 2>&1 && echo "  - GitHub CLI: $(gh --version | head -1)"
    echo ""
    echo "Agent CLI:"
    case "${AGENT_TYPE:-claude}" in
        claude)
            command -v claude >/dev/null 2>&1 && echo "  - Claude: $(claude --version 2>&1 | head -1)" || echo "  - Claude: not found"
            ;;
        copilot)
            command -v copilot >/dev/null 2>&1 && echo "  - Copilot: installed" || echo "  - Copilot: not found"
            ;;
        opencode)
            command -v opencode >/dev/null 2>&1 && echo "  - OpenCode: installed" || echo "  - OpenCode: not found"
            ;;
        gemini)
            command -v gemini >/dev/null 2>&1 && echo "  - Gemini: installed" || echo "  - Gemini: not found"
            ;;
    esac
    echo ""
    echo "Working directory: $(pwd)"
    echo ""
    exec /bin/bash
fi

# =============================================================================
# Workflow Mode
# =============================================================================

echo "=== Heretic Agent (Workflow Mode) ==="
echo "Agent type: ${AGENT_TYPE:-claude}"
echo "STEP_NAME: ${STEP_NAME:-not set}"
echo "REPO_PATH: ${REPO_PATH:-not set}"
echo "PROMPT_FILE: ${PROMPT_FILE}"
echo "AGENT_OUTPUT_FORMAT: ${AGENT_OUTPUT_FORMAT:-stream-json}"
echo ""

if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: Prompt file not found: $PROMPT_FILE"
    exit 1
fi

PROMPT_CONTENT=$(cat "$PROMPT_FILE")
echo "Prompt length: ${#PROMPT_CONTENT} characters"
echo ""

# Configure git credentials
if [[ -n "${GH_TOKEN:-}" ]] || [[ -n "${GITHUB_TOKEN:-}" ]]; then
    TOKEN="${GH_TOKEN:-${GITHUB_TOKEN}}"
    git config --global credential.helper store
    echo "https://x-access-token:${TOKEN}@github.com" > ~/.git-credentials
    echo "Git credentials configured"
fi

git config --global user.email "agent@example.com"
git config --global user.name "Heretic Agent"

for hooks_path in "${REPO_PATH}/.githooks" "/workspace/.githooks"; do
    if [[ -d "$hooks_path" ]]; then
        git config --global core.hooksPath "$hooks_path"
        echo "Git hooks configured: $hooks_path"
        break
    fi
done

# Agent-specific settings
case "${AGENT_TYPE:-claude}" in
    claude)
        SETTINGS_SOURCE="${HERETIC_DIR:-/workspace/.heretic}/claude-settings.json"
        if [[ -f "$SETTINGS_SOURCE" ]]; then
            mkdir -p ~/.claude
            cp "$SETTINGS_SOURCE" ~/.claude/settings.json
            echo "Claude settings configured"
        fi
        ;;
    opencode)
        SETTINGS_SOURCE="${HERETIC_DIR:-/workspace/.heretic}/opencode.json"
        if [[ -f "$SETTINGS_SOURCE" ]]; then
            mkdir -p ~/.config/opencode
            cp "$SETTINGS_SOURCE" ~/.config/opencode/config.json
            echo "OpenCode settings configured"
        fi
        ;;
    gemini)
        if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
            echo "Gemini API key configured"
        fi
        ;;
    copilot)
        if [[ -n "${GITHUB_TOKEN:-}" ]] || [[ -n "${GH_TOKEN:-}" ]]; then
            echo "Copilot token configured"
        fi
        ;;
esac

# Process AGENT_ARGS
declare -a PROCESSED_ARGS=()

process_arg() {
    local arg="$1"
    if [[ "$arg" == file:* ]]; then
        local filepath="${arg#file:}"
        if [[ -f "$filepath" ]]; then
            cat "$filepath"
        else
            echo "WARNING: File not found: $filepath" >&2
            echo "$arg"
        fi
    elif [[ "$arg" == exec:* ]]; then
        local cmd="${arg#exec:}"
        eval "$cmd" 2>&1 || echo ""
    else
        echo "$arg"
    fi
}

if [[ -n "${AGENT_ARGS:-}" ]]; then
    eval "local -a raw_args=($AGENT_ARGS)"
    for arg in "${raw_args[@]}"; do
        processed=$(process_arg "$arg")
        PROCESSED_ARGS+=("$processed")
    done
fi

# Build agent command
declare -a AGENT_CMD=()

case "${AGENT_TYPE:-claude}" in
    claude)
        AGENT_CMD=(claude --print)
        OUTPUT_FORMAT="${AGENT_OUTPUT_FORMAT:-stream-json}"
        AGENT_CMD+=(--output-format "$OUTPUT_FORMAT")
        if [[ "$OUTPUT_FORMAT" == "stream-json" ]]; then
            AGENT_CMD+=(--verbose)
        fi
        if [[ ${#PROCESSED_ARGS[@]} -gt 0 ]]; then
            AGENT_CMD+=("${PROCESSED_ARGS[@]}")
        fi
        ;;
    copilot)
        AGENT_CMD=(copilot)
        if [[ ${#PROCESSED_ARGS[@]} -gt 0 ]]; then
            AGENT_CMD+=("${PROCESSED_ARGS[@]}")
        fi
        ;;
    opencode)
        AGENT_CMD=(opencode)
        if [[ ${#PROCESSED_ARGS[@]} -gt 0 ]]; then
            AGENT_CMD+=("${PROCESSED_ARGS[@]}")
        fi
        ;;
    gemini)
        AGENT_CMD=(gemini)
        if [[ ${#PROCESSED_ARGS[@]} -gt 0 ]]; then
            AGENT_CMD+=("${PROCESSED_ARGS[@]}")
        fi
        ;;
    *)
        echo "ERROR: Unknown agent type: ${AGENT_TYPE}"
        exit 1
        ;;
esac

echo "=== Starting ${AGENT_TYPE} Agent ==="
echo "Command: ${AGENT_CMD[*]}"
echo ""

cd "${REPO_PATH:-/workspace}"
exec "${AGENT_CMD[@]}" "$PROMPT_CONTENT"
