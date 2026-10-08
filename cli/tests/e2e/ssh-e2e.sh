#!/bin/bash
# End-to-end test of the SSH tool-execution backend against a REAL sshd.
#
# Starts a private sshd on 127.0.0.1/0.0.0.0:$E2E_PORT using the machine's
# /etc/ssh host keys, creates a throw-away host user with fake toolchains
# (cargo via ~/.profile, npm via an interactive-only ~/.bashrc, like nvm), then:
#   1. drives ssh-exec directly (path mapping, quoting, exit codes, env, probe,
#      host-key pinning, key permissions, 40 parallel calls, orphan cleanup)
#   2. runs the compiled `heretic-cli ssh setup` + `ssh check` as that user
#   3. (E2E_CONTAINER=1) runs the real entrypoint + ssh-exec inside a container
#      that reaches the host through host-gateway
#
# Needs root (useradd, sshd). Usage:
#   sudo HERETIC_CLI=dist/heretic-cli tests/e2e/ssh-e2e.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$HERE/../../src/templates/assets"
CLI="${HERETIC_CLI:-}"
PORT="${E2E_PORT:-2222}"
E2E_USER="${E2E_USER:-heretice2e}"
LAB="$(mktemp -d /tmp/heretic-ssh-e2e.XXXXXX)"
chmod 755 "$LAB"
FAILS=0
SSHD_PID=""

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }
expect_eq() { # <name> <expected> <actual>
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1: expected [$2] got [$3]"; fi
}

cleanup() {
    [[ -n "$SSHD_PID" ]] && kill "$SSHD_PID" 2>/dev/null
    pkill -u "$E2E_USER" 2>/dev/null || true
}
trap cleanup EXIT

[[ "$(id -u)" == "0" ]] || { echo "must run as root" >&2; exit 2; }
command -v /usr/sbin/sshd >/dev/null || { echo "openssh-server is not installed" >&2; exit 2; }
[[ -f /etc/ssh/ssh_host_ed25519_key ]] || ssh-keygen -A

# --- host user with fake toolchains ------------------------------------------
id "$E2E_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$E2E_USER"
usermod -p '*' "$E2E_USER"   # unlock for public-key login without PAM
HOME_DIR="$(getent passwd "$E2E_USER" | cut -d: -f6)"
mkdir -p "$HOME_DIR/.cargo/bin" "$HOME_DIR/.nvm/bin" "$HOME_DIR/proj/crates/core"
printf '#!/bin/sh\necho "cargo-host $* (cwd=$(pwd))"\n' > "$HOME_DIR/.cargo/bin/cargo"
printf '#!/bin/sh\necho "npm-host $* (cwd=$(pwd))"\n' > "$HOME_DIR/.nvm/bin/npm"
chmod +x "$HOME_DIR/.cargo/bin/cargo" "$HOME_DIR/.nvm/bin/npm"
printf 'case $- in *i*) ;; *) return;; esac\nexport PATH="$HOME/.nvm/bin:$PATH"\n' > "$HOME_DIR/.bashrc"
printf '[ -f ~/.bashrc ] && . ~/.bashrc\nexport PATH="$HOME/.cargo/bin:$PATH"\n' > "$HOME_DIR/.profile"
# bash reads ~/.profile only when there is no ~/.bash_profile / ~/.bash_login
# (some /etc/skel ship one) — keep the login environment deterministic.
rm -f "$HOME_DIR/.bash_profile" "$HOME_DIR/.bash_login"
mkdir -p "$HOME_DIR/.heretic/agents"
cat > "$HOME_DIR/.heretic/agents/e2e.yaml" <<EOF
image: ${E2E_IMAGE:-heretic-ssh-e2e:latest}
runner: docker
agent_type: claude
provider: anthropic
volumes:
  - source: \${CWD}
    target: /workspace
workdir: /workspace
EOF
chown -R "$E2E_USER:$E2E_USER" "$HOME_DIR"
chmod 755 "$HOME_DIR"
# `ssh check --container` runs docker as this user.
[[ "${E2E_CONTAINER:-0}" == "1" ]] && getent group docker >/dev/null && usermod -aG docker "$E2E_USER"

# --- private sshd ---------------------------------------------------------------
mkdir -p /run/sshd
cat > "$LAB/sshd_config" <<EOF
Port $PORT
ListenAddress ${E2E_LISTEN:-127.0.0.1}
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_rsa_key
PidFile $LAB/sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
EOF
/usr/sbin/sshd -f "$LAB/sshd_config" -E "$LAB/sshd.log" || { echo "sshd failed to start"; cat "$LAB/sshd.log"; exit 1; }
sleep 0.5
SSHD_PID="$(cat "$LAB/sshd.pid")"
echo "sshd on :$PORT (pid $SSHD_PID), user $E2E_USER, lab $LAB"

# Direct-test key, authorized with the same options `ssh setup` uses.
ssh-keygen -q -t ed25519 -N "" -f "$LAB/key"
mkdir -p "$HOME_DIR/.ssh"
echo "restrict,pty $(cat "$LAB/key.pub")" > "$HOME_DIR/.ssh/authorized_keys"
chown -R "$E2E_USER:$E2E_USER" "$HOME_DIR/.ssh"; chmod 700 "$HOME_DIR/.ssh"; chmod 600 "$HOME_DIR/.ssh/authorized_keys"
echo "[127.0.0.1]:$PORT $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > "$LAB/known_hosts"

SSH_EXEC="$LAB/ssh-exec"
cp "$ASSETS/ssh-exec" "$SSH_EXEC"; chmod +x "$SSH_EXEC"
mkdir -p "$LAB/ws/crates/core"

export SSH_HOST=127.0.0.1 SSH_PORT="$PORT" SSH_USER="$E2E_USER" SSH_KEY_PATH="$LAB/key" \
    SSH_KNOWN_HOSTS="$LAB/known_hosts" SSH_WORKSPACE="$LAB/ws" SSH_HOST_CWD="$HOME_DIR/proj" \
    SSH_RUNTIME_DIR="$LAB/rt"

echo "== 1. ssh-exec against a real sshd"
cd "$LAB/ws/crates/core" || exit 1
expect_eq "cwd is mapped to the host project" "$HOME_DIR/proj/crates/core" "$("$SSH_EXEC" pwd)"
expect_eq "--check" "ok" "$("$SSH_EXEC" --check)"
"$SSH_EXEC" sh -c 'exit 7'; expect_eq "exit code passthrough" "7" "$?"
expect_eq "quoting" "[it's][*][\$HOME][a b][\`id\`]" "$("$SSH_EXEC" printf '[%s]' "it's" '*' '$HOME' 'a b' '`id`')"
expect_eq "argument path mapping" "--manifest-path=$HOME_DIR/proj/Cargo.toml" "$("$SSH_EXEC" echo "--manifest-path=$LAB/ws/Cargo.toml")"
expect_eq "stdin is forwarded" "2" "$(printf 'a\nb\n' | "$SSH_EXEC" wc -l | tr -d ' ')"
expect_eq "non-login shell misses ~/.profile tools" "127" "$("$SSH_EXEC" cargo build >/dev/null 2>&1; echo $?)"
expect_eq "login shell finds cargo" "cargo-host build (cwd=$HOME_DIR/proj/crates/core)" "$(SSH_LOGIN_SHELL=1 "$SSH_EXEC" cargo build)"
expect_eq "captured PATH finds npm" "npm-host ci (cwd=$HOME_DIR/proj/crates/core)" \
    "$(SSH_HOST_PATH="$HOME_DIR/.nvm/bin:/usr/bin:/bin" "$SSH_EXEC" npm ci)"
expect_eq "env passthrough (allowlist only)" "ci=1 secret=" \
    "$(CI=1 SECRET=x SSH_ENV_PASSTHROUGH=CI "$SSH_EXEC" sh -c 'echo "ci=$CI secret=${SECRET:-}"')"
expect_eq "--probe" "cargo npm" \
    "$(SSH_HOST_PATH="$HOME_DIR/.cargo/bin:$HOME_DIR/.nvm/bin:/usr/bin:/bin" "$SSH_EXEC" --probe cargo npm no-such-tool | tr '\n' ' ' | sed 's/ $//')"

echo "[127.0.0.1]:$PORT ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > "$LAB/bad_known_hosts"
SSH_CONTROL_PERSIST=0 SSH_KNOWN_HOSTS="$LAB/bad_known_hosts" "$SSH_EXEC" true >/dev/null 2>&1
expect_eq "wrong pinned host key is rejected" "255" "$?"

: > "$LAB/empty_key"
SSH_KEY_PATH="$LAB/empty_key" "$SSH_EXEC" true >/dev/null 2>&1
expect_eq "empty key is refused" "2" "$?"

cp "$LAB/key" "$LAB/loose_key"; chmod 644 "$LAB/loose_key"
expect_eq "0644 key is copied and used" "ok" "$(SSH_CONTROL_PERSIST=0 SSH_KEY_PATH="$LAB/loose_key" "$SSH_EXEC" echo ok)"

start=$(date +%s)
SSH_CONTROL_PERSIST=0 SSH_PORT=1 SSH_CONNECT_TIMEOUT=3 "$SSH_EXEC" true >/dev/null 2>&1
rc=$?; elapsed=$(( $(date +%s) - start ))
expect_eq "unreachable host fails (255) without hanging" "255 fast" "$rc $([[ $elapsed -le 5 ]] && echo fast || echo slow)"

mkdir -p "$LAB/par"
for i in $(seq 40); do ("$SSH_EXEC" sh -c "sleep 0.3; echo $i" >"$LAB/par/o.$i" 2>"$LAB/par/e.$i") & done; wait
expect_eq "40 parallel calls succeed" "40" "$(cat "$LAB"/par/o.* | wc -l | tr -d ' ')"
expect_eq "... with clean stderr" "0" "$(cat "$LAB"/par/e.* | wc -l | tr -d ' ')"

"$SSH_EXEC" sh -c 'sleep 41 & sh -c "sleep 42" & wait' </dev/null >/dev/null 2>&1 &
wrapper=$!; sleep 1.5
before=$(pgrep -u "$E2E_USER" -fc 'sleep 4[12]')
kill -TERM "$wrapper"; wait "$wrapper"; rc=$?; sleep 1
after=$(pgrep -u "$E2E_USER" -fc 'sleep 4[12]')
expect_eq "TERM kills the remote process tree" "running 143 0" "$([[ $before -gt 0 ]] && echo running || echo idle) $rc $after"

# Universal launcher: the host built target/release/app. The container sees it
# as a binary it cannot execute (simulated with a Mach-O header on the
# container side), so auto-run sends it to the host; a local script stays local.
mkdir -p "$HOME_DIR/proj/target/release" "$LAB/ws/target/release"
printf '#!/bin/sh\necho "app-on-host $*"\n' > "$HOME_DIR/proj/target/release/app"
chmod 755 "$HOME_DIR/proj/target/release/app"
printf '\xcf\xfa\xed\xfe\x0c\x00\x00\x01' > "$LAB/ws/target/release/app"
chmod 755 "$LAB/ws/target/release/app"
printf '#!/bin/sh\necho local-tool\n' > "$LAB/ws/local-tool"; chmod 755 "$LAB/ws/local-tool"
cd "$LAB/ws" || exit 1
expect_eq "auto-run: host-only binary runs on the host" "app-on-host --port 8080" \
    "$("$SSH_EXEC" --auto ./target/release/app --port 8080)"
expect_eq "auto-run: absolute workspace path is mapped" "app-on-host" \
    "$("$SSH_EXEC" --auto "$LAB/ws/target/release/app" | sed 's/ $//')"
expect_eq "auto-run: runnable file stays local" "local-tool" "$("$SSH_EXEC" --auto ./local-tool)"
expect_eq "host-run: always on the host" "$E2E_USER" "$("$SSH_EXEC" --run whoami)"
cd "$LAB/ws/crates/core" || exit 1

# --- 2. CLI: ssh setup + ssh check as the host user ------------------------------
if [[ -n "$CLI" ]]; then
    echo "== 2. heretic-cli ssh setup / check"
    install -m 755 "$CLI" "$LAB/heretic-cli"
    as_user() { su "$E2E_USER" -s /bin/bash -c "cd $HOME_DIR/proj && HOME=$HOME_DIR $*"; }
    out=$(as_user "$LAB/heretic-cli ssh setup e2e --port $PORT --presets rust,node" 2>&1); rc=$?
    echo "$out" | sed 's/^/    /'
    expect_eq "ssh setup exit code" "0" "$rc"
    expect_eq "generated key is private" "600" "$(stat -c %a "$HOME_DIR/.heretic/ssh/e2e_ed25519")"
    grep -q "host_path: .*\.nvm/bin" "$HOME_DIR/.heretic/agents/e2e.yaml" \
        && pass "interactive login PATH captured (nvm-style .bashrc)" || fail "host_path not captured"
    grep -q "known_hosts:" "$HOME_DIR/.heretic/agents/e2e.yaml" && pass "host key pinned" || fail "no known_hosts"
    out=$(as_user "$LAB/heretic-cli ssh setup e2e --port $PORT --presets rust,node" 2>&1)
    expect_eq "setup is idempotent (one authorized key)" "1" "$(grep -c heretic-e2e "$HOME_DIR/.ssh/authorized_keys")"
    out=$(as_user "$LAB/heretic-cli ssh check e2e" 2>&1); rc=$?
    echo "$out" | sed 's/^/    /'
    expect_eq "ssh check exit code" "0" "$rc"
    echo "$out" | grep -q "cargo" && pass "check sees cargo on the host" || fail "check missed cargo"
fi

# --- 3. real container → host-gateway → host -------------------------------------
if [[ "${E2E_CONTAINER:-0}" == "1" ]]; then
    echo "== 3. container → host.docker.internal (host-gateway) → sshd"
    IMG="${E2E_IMAGE:-heretic-ssh-e2e:latest}"
    docker build -q -t "$IMG" - >/dev/null <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client jq procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 agent \
    && mkdir -p /opt/sidecar/wrappers && chown 1000:1000 /opt/sidecar/wrappers
ENV PATH="/opt/sidecar/wrappers:${PATH}"
USER agent
EOF
    # Same staging the runner does: 0644 copy in a 0700 dir (host uid != 1000).
    KEY="$LAB/run/e2e.key"
    install -d -m 700 -o "$E2E_USER" "$LAB/run"
    install -m 644 -o "$E2E_USER" "$HOME_DIR/.heretic/ssh/e2e_ed25519" "$KEY"
    WS_OUT=$(docker run --rm \
        --add-host host.docker.internal:host-gateway \
        -v "$SSH_EXEC:/opt/sidecar/ssh-exec:ro" \
        -v "$ASSETS/entrypoint.sh:/entrypoint.sh:ro" \
        -v "$KEY:/etc/heretic/ssh/key:ro" \
        -v "$HOME_DIR/.heretic/ssh/e2e_known_hosts:/etc/heretic/ssh/known_hosts:ro" \
        -v "$HOME_DIR/proj:/workspace" -w /workspace/crates/core \
        -e SSH_HOST=host.docker.internal -e SSH_PORT="$PORT" -e SSH_USER="$E2E_USER" \
        -e SSH_KEY_PATH=/etc/heretic/ssh/key -e SSH_KNOWN_HOSTS=/etc/heretic/ssh/known_hosts \
        -e SSH_WORKSPACE=/workspace -e SSH_HOST_CWD="$HOME_DIR/proj" -e SSH_LOGIN_SHELL=1 \
        -e SSH_COMMANDS="cargo rustc npm pnpm bash ssh" \
        --entrypoint /bin/bash "$IMG" -c \
        'source <(sed -n "/^setup_tool_wrappers() {/,/^}/p" /entrypoint.sh); setup_tool_wrappers >/dev/null; ls /opt/sidecar/wrappers | tr "\n" " "; echo; cargo build --release; host-run whoami; auto-run cargo --version' 2>&1)
    echo "$WS_OUT" | sed 's/^/    /'
    echo "$WS_OUT" | grep -q "^auto-run cargo host-run npm $" && pass "entrypoint wrapped the host's commands + launchers" || fail "unexpected wrapper set"
    echo "$WS_OUT" | grep -qx "$E2E_USER" && pass "host-run from the container runs as the host user" || fail "host-run failed"
    echo "$WS_OUT" | grep -q "cargo-host --version" && pass "auto-run routes a command missing in the container" || fail "auto-run failed"
    echo "$WS_OUT" | grep -q "cargo-host build --release (cwd=$HOME_DIR/proj/crates/core)" \
        && pass "cargo from the container ran on the host in the mapped dir" || fail "container → host cargo failed"
    if [[ -n "$CLI" ]]; then
        out=$(su "$E2E_USER" -s /bin/bash -c "cd $HOME_DIR/proj && HOME=$HOME_DIR $LAB/heretic-cli ssh check e2e --container" 2>&1); rc=$?
        echo "$out" | sed 's/^/    /'
        expect_eq "ssh check --container" "0" "$rc"
    fi
fi

echo
if [[ $FAILS -eq 0 ]]; then echo "SSH e2e: all checks passed"; else echo "SSH e2e: $FAILS check(s) FAILED"; fi
exit $(( FAILS > 0 ))
