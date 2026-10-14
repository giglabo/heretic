#!/usr/bin/env bash
# Real-world SSH backend test: a Linux container → THIS machine (macOS or Linux) over SSH.
#
# Runs as you, against your own sshd, the way a user would use the feature:
#   1. creates a throw-away profile + C project under ~/.heretic/e2e/
#   2. `heretic-cli ssh setup` (key, authorized_keys, host key, PATH, presets)
#   3. `heretic-cli ssh check`
#   4. host side: ssh-exec builds the project on this machine (`make`/`cc`) and
#      auto-run/host-run route the host binary (Mach-O on macOS) to the host
#   5. container side (needs Docker): `ssh check --container` and
#      `heretic-cli ssh exec` — `make` and `auto-run ./hello` from a Linux
#      container execute on this machine
# Everything it adds (profile, keys, the authorized_keys line, files) is removed
# at exit unless --keep.
#
# Prerequisites: sshd reachable on 127.0.0.1:<port> and, for step 5, from containers.
#   macOS: System Settings → General → Sharing → Remote Login; Docker Desktop.
#   Linux: openssh-server running; sshd must listen on the Docker bridge too.
#
# Usage: scripts/test-ssh-docker-host.sh [--cli PATH] [--port N] [--no-container] [--keep]
#
# bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/cli/dist/heretic-cli"
PORT=22
CONTAINER=1
KEEP=0
IMAGE="heretic-ssh-e2e:latest"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cli) CLI="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --no-container) CONTAINER=0; shift ;;
        --keep) KEEP=1; shift ;;
        -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

OS="$(uname -s)"
ME="$(id -un)"
FAILS=0
pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }
expect_eq() { if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1: expected [$2] got [$3]"; fi; }
expect_has() { if [[ "$3" == *"$2"* ]]; then pass "$1"; else fail "$1: [$2] not in output:"; echo "$3" | sed 's/^/      /'; fi; }

[[ -x "$CLI" ]] || { echo "no heretic-cli at $CLI — run scripts/build.sh first or pass --cli" >&2; exit 2; }
for tool in ssh ssh-keygen ssh-keyscan; do
    command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done
if [[ -z "$(ssh-keyscan -p "$PORT" -T 5 127.0.0.1 2>/dev/null)" ]]; then
    echo "no sshd on 127.0.0.1:$PORT" >&2
    if [[ "$OS" == Darwin ]]; then
        echo "  enable Remote Login: System Settings → General → Sharing → Remote Login" >&2
    else
        echo "  sudo apt install openssh-server && sudo systemctl enable --now ssh" >&2
    fi
    exit 2
fi
if [[ $CONTAINER == 1 ]] && ! docker info >/dev/null 2>&1; then
    echo "Docker is not available — rerun with --no-container to test only the host side" >&2
    exit 2
fi

# Under $HOME: shared with Docker Desktop by default, and not a macOS
# privacy-protected folder (Documents/Desktop/Downloads).
PROFILE="heretic-e2e-$$"
WORK="$HOME/.heretic/e2e/$PROFILE"
PROJ="$WORK/proj"
WS="$WORK/ws"   # stands in for the container's /workspace on the host-side checks
AGENTS="$HOME/.heretic/agents"
# sshd reads authorized_keys from the passwd home, which can differ from $HOME
PW_HOME="$(eval echo "~$ME")"
AUTH="$PW_HOME/.ssh/authorized_keys"

cleanup() {
    pkill -f "sleep 37$$" 2>/dev/null || true
    [[ $KEEP == 1 ]] && { echo "kept: profile $PROFILE, $WORK"; return; }
    rm -f "$AGENTS/$PROFILE.yaml" "$HOME/.heretic/ssh/${PROFILE}_ed25519"* \
        "$HOME/.heretic/ssh/${PROFILE}_known_hosts" "$HOME/.heretic/ssh/run/$PROFILE.key"
    if [[ -f "$AUTH" ]] && grep -q "heretic-$PROFILE" "$AUTH"; then
        grep -v "heretic-$PROFILE" "$AUTH" > "$AUTH.heretic-tmp" || true
        cat "$AUTH.heretic-tmp" > "$AUTH" && rm -f "$AUTH.heretic-tmp"   # keeps the file's mode
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$PROJ" "$AGENTS"
ln -s "$PROJ" "$WS"
cat > "$PROJ/hello.c" <<'EOF'
#include <stdio.h>
int main(int argc, char **argv) {
#ifdef __APPLE__
    const char *os = "Darwin";
#else
    const char *os = "Linux";
#endif
    printf("hello from %s%s%s\n", os, argc > 1 ? " " : "", argc > 1 ? argv[1] : "");
    return 0;
}
EOF
printf 'hello: hello.c\n\tcc -O2 -o hello hello.c\n\nclean:\n\trm -f hello\n' > "$PROJ/Makefile"
cat > "$AGENTS/$PROFILE.yaml" <<EOF
image: $IMAGE
runner: docker
agent_type: claude
provider: anthropic
volumes:
  - source: \${CWD}
    target: /workspace
workdir: /workspace
EOF

echo "SSH docker-host test on $OS as $ME (sshd :$PORT, profile $PROFILE)"
cd "$PROJ" || exit 1

echo "== ssh setup / check"
out=$("$CLI" ssh setup "$PROFILE" --port "$PORT" --presets build --commands cc 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
expect_eq "ssh setup" "0" "$rc"
out=$("$CLI" ssh check "$PROFILE" 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
expect_eq "ssh check" "0" "$rc"
expect_has "host has make" "make" "$out"

echo "== host side: the embedded ssh-exec against this machine"
SSH_EXEC="$WORK/ssh-exec"
"$CLI" image generate --format ssh-exec > "$SSH_EXEC" && chmod +x "$SSH_EXEC" \
    || { fail "cannot extract ssh-exec from $CLI"; exit 1; }
alias_name="host.docker.internal"; [[ "$PORT" != 22 ]] && alias_name="[host.docker.internal]:$PORT"
export SSH_HOST=127.0.0.1 SSH_PORT="$PORT" SSH_USER="$ME" \
    SSH_KEY_PATH="$HOME/.heretic/ssh/${PROFILE}_ed25519" \
    SSH_KNOWN_HOSTS="$HOME/.heretic/ssh/${PROFILE}_known_hosts" SSH_HOST_KEY_ALIAS="$alias_name" \
    SSH_WORKSPACE="$WS" SSH_HOST_CWD="$PROJ" SSH_LOGIN_SHELL=1
cd "$WS" || exit 1
expect_eq "--check (pinned host key, mapped cwd)" "ok" "$("$SSH_EXEC" --check 2>&1)"
"$SSH_EXEC" make >/dev/null 2>&1
if [[ -x "$PROJ/hello" ]]; then pass "make builds on the host"; else fail "make did not produce ./hello"; fi
magic=$(od -An -tx1 -N4 "$PROJ/hello" 2>/dev/null | tr -d ' \n')
if [[ "$OS" == Darwin ]]; then
    case "$magic" in cffaedfe | cefaedfe | cafebabe) pass "host produced a Mach-O binary" ;; *) fail "expected Mach-O, magic=$magic" ;; esac
else
    expect_eq "host produced an ELF binary" "7f454c46" "$magic"
fi
expect_eq "auto-run ./hello" "hello from $OS x" "$("$SSH_EXEC" --auto ./hello x 2>&1)"
expect_eq "host-run uname -s" "$OS" "$("$SSH_EXEC" --run uname -s 2>&1)"
"$SSH_EXEC" --run sh -c "exec sleep 37$$" </dev/null >/dev/null 2>&1 &
wrapper=$!; sleep 2
if ! pgrep -f "sleep 37$$" >/dev/null; then
    fail "host process did not start"
else
    kill -TERM "$wrapper"; wait "$wrapper" 2>/dev/null; sleep 1
    if pgrep -f "sleep 37$$" >/dev/null; then fail "interrupted host process still running"; else pass "TERM kills the host process"; fi
fi
mkdir -p "$WORK/par"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    ("$SSH_EXEC" --run echo "$i" >"$WORK/par/$i" 2>&1) &
done
wait
expect_eq "20 parallel calls" "20" "$(cat "$WORK"/par/* | grep -c '^[0-9]*$')"
unset SSH_HOST SSH_PORT SSH_USER SSH_KEY_PATH SSH_KNOWN_HOSTS SSH_HOST_KEY_ALIAS SSH_WORKSPACE SSH_HOST_CWD SSH_LOGIN_SHELL
cd "$PROJ" || exit 1

if [[ $CONTAINER == 1 ]]; then
    echo "== container side: Linux container → $OS host"
    docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client jq procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 agent \
    && mkdir -p /opt/sidecar/wrappers && chown 1000:1000 /opt/sidecar/wrappers
ENV PATH="/opt/sidecar/wrappers:${PATH}"
USER agent
EOF
    out=$("$CLI" ssh check "$PROFILE" --container 2>&1); rc=$?
    echo "$out" | sed 's/^/    /'
    expect_eq "ssh check --container" "0" "$rc"
    expect_eq "container is Linux" "Linux" "$("$CLI" ssh exec "$PROFILE" -- uname -s 2>/dev/null)"
    expect_eq "host-run from the container" "$OS" "$("$CLI" ssh exec "$PROFILE" -- host-run uname -s 2>/dev/null)"
    rm -f "$PROJ/hello"
    "$CLI" ssh exec "$PROFILE" -- make >/dev/null 2>&1
    expect_eq "make from the container builds on the host" "0" "$?"
    out=$("$CLI" ssh exec "$PROFILE" -- auto-run ./hello y 2>&1)
    if [[ "$OS" == Darwin ]]; then
        expect_eq "auto-run sends the Mach-O to the host" "hello from Darwin y" "$(echo "$out" | tail -1)"
    else
        expect_has "auto-run runs the host-built ELF" "hello from Linux y" "$out"
    fi
fi

echo
if [[ $FAILS -eq 0 ]]; then echo "docker-host SSH test: all checks passed"; else echo "docker-host SSH test: $FAILS check(s) FAILED"; fi
exit $((FAILS > 0))
