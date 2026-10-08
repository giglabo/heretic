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
# Root Mode — keep /home/agent as HOME when the container runs as root
# =============================================================================

if [[ "$(id -u)" == "0" ]] && [[ -n "${HERETIC_RUN_AS_ROOT:-}" ]]; then
    # Run as root but reuse the agent user's home directory so all the
    # bind-mounted config (claude settings, .claude.json, auth, ssh keys)
    # still resolves under $HOME.
    AGENT_USER="${AGENT_USER:-agent}"
    export HOME="/home/$AGENT_USER"
    export USER="root"
    echo "Running as root (HOME=$HOME)"
fi

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

    # SSH backend: route exactly the commands listed in SSH_COMMANDS (expanded
    # from the profile's ssh.presets / ssh.commands by heretic-cli). Images run
    # by other orchestrators may set only SSH_HOST: fall back to every runtime
    # command, which was the original behaviour.
    declare -A SSH_CMDS=()
    local has_ssh="false"
    if [[ -n "${SSH_HOST:-}" ]]; then
        has_ssh="true"
        local ssh_list="${SSH_COMMANDS:-}"
        if [[ -z "$ssh_list" ]]; then
            ssh_list="${RUNTIME_COMMANDS[*]}"
        fi
        for cmd in ${ssh_list//,/ }; do
            SSH_CMDS["$cmd"]=1
        done
    fi

    if [[ ${#SIDECAR_RUNTIMES[@]} -eq 0 ]] && [[ "$has_ssh" == "false" ]]; then
        return 0
    fi

    # A backend IS configured, so we are about to write wrappers. Fail with a clear
    # message if the dir is not writable, instead of dying on a bare "Permission
    # denied" under `set -e` (the image must chown $WRAPPER_DIR to the agent user).
    if ! (: > "$WRAPPER_DIR/.probe") 2>/dev/null; then
        echo "FATAL: $WRAPPER_DIR is not writable by $(id -un) (uid $(id -u)); tool backends disabled" >&2
        echo "       rebuild the agent image so /opt/sidecar/wrappers is owned by the agent user" >&2
        exit 1
    fi
    rm -f "$WRAPPER_DIR/.probe"

    # Never shadow the shell, ssh itself, privilege tools or the agent CLIs: a
    # wrapper for any of these would hand the agent's own process to the host.
    declare -A SSH_DENY=()
    for cmd in ssh scp sftp ssh-agent ssh-add sh bash dash zsh fish env sudo su \
        exec nohup timeout claude copilot opencode gemini aider heretic-cli \
        ssh-exec sidecar-exec; do
        SSH_DENY["$cmd"]=1
    done

    declare -A CMD_RUNTIME=()
    local -a candidates=()
    for runtime in "${!RUNTIME_COMMANDS[@]}"; do
        for cmd in ${RUNTIME_COMMANDS[$runtime]}; do
            CMD_RUNTIME["$cmd"]="$runtime"
            candidates+=("$cmd")
        done
    done
    for cmd in "${!SSH_CMDS[@]}"; do
        [[ -z "${CMD_RUNTIME[$cmd]+x}" ]] && candidates+=("$cmd")
    done

    local clean_path
    clean_path=$(echo "$PATH" | tr ':' '\n' | grep -v "$WRAPPER_DIR" | tr '\n' ':' | sed 's/:$//')

    local wrapper_count=0
    local -a ssh_candidates=()

    for cmd in "${candidates[@]}"; do
        # Names end up in a heredoc and a file name: accept plain tokens only.
        [[ "$cmd" =~ ^[A-Za-z0-9._+-]+$ ]] || continue

        # The container always wins.
        if PATH="$clean_path" command -v "$cmd" >/dev/null 2>&1; then
            continue
        fi

        local runtime="${CMD_RUNTIME[$cmd]:-}"
        if [[ -n "$runtime" ]] && [[ -n "${SIDECAR_RUNTIMES[$runtime]+x}" ]]; then
            cat > "$WRAPPER_DIR/$cmd" <<WRAPPER
#!/bin/bash
exec /opt/sidecar/sidecar-exec "$runtime" "$cmd" "\$@"
WRAPPER
            chmod +x "$WRAPPER_DIR/$cmd"
            wrapper_count=$((wrapper_count + 1))
            continue
        fi

        if [[ -n "${SSH_CMDS[$cmd]+x}" ]] && [[ -z "${SSH_DENY[$cmd]+x}" ]]; then
            ssh_candidates+=("$cmd")
        fi
    done

    if [[ ${#ssh_candidates[@]} -gt 0 ]]; then
        local -a ssh_routed=("${ssh_candidates[@]}")

        # Ask the host which of the candidates it actually has (one round trip;
        # it also opens the shared connection). On failure keep them all, so the
        # commands start working once the host becomes reachable.
        if [[ "${SSH_PROBE:-1}" != "0" ]]; then
            local found
            if found=$(SSH_CONNECT_TIMEOUT="${SSH_PROBE_TIMEOUT:-5}" /opt/sidecar/ssh-exec --probe "${ssh_candidates[@]}" 2>/tmp/heretic-ssh-probe.err); then
                ssh_routed=()
                local -A on_host=()
                for cmd in $found; do on_host["$cmd"]=1; done
                for cmd in "${ssh_candidates[@]}"; do
                    [[ -n "${on_host[$cmd]+x}" ]] && ssh_routed+=("$cmd")
                done
                echo "SSH backend: ${SSH_USER:-agent}@${SSH_HOST}:${SSH_PORT:-22} reachable; ${#ssh_routed[@]}/${#ssh_candidates[@]} commands found on host"
            else
                echo "WARNING: SSH backend ${SSH_USER:-agent}@${SSH_HOST}:${SSH_PORT:-22} unreachable at start-up; routing all ${#ssh_candidates[@]} listed commands anyway" >&2
                sed 's/^/         /' /tmp/heretic-ssh-probe.err >&2 || true
            fi
        fi

        for cmd in "${ssh_routed[@]}"; do
            cat > "$WRAPPER_DIR/$cmd" <<WRAPPER
#!/bin/bash
exec /opt/sidecar/ssh-exec "$cmd" "\$@"
WRAPPER
            chmod +x "$WRAPPER_DIR/$cmd"
            wrapper_count=$((wrapper_count + 1))
        done
    fi

    # Universal launchers: run anything on the host (`host-run`), or locally when
    # the container can execute it and on the host otherwise (`auto-run`) — e.g.
    # the binary a host-side `cargo build` just produced.
    if [[ "$has_ssh" == "true" ]] && [[ "${SSH_HOST_RUN:-1}" != "0" ]]; then
        printf '#!/bin/bash\nexec /opt/sidecar/ssh-exec --run "$@"\n' > "$WRAPPER_DIR/host-run"
        printf '#!/bin/bash\nexec /opt/sidecar/ssh-exec --auto "$@"\n' > "$WRAPPER_DIR/auto-run"
        chmod +x "$WRAPPER_DIR/host-run" "$WRAPPER_DIR/auto-run"
        echo "Host launchers: host-run <cmd> (always host), auto-run <cmd> (local if runnable, else host)"
    fi

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
