#!/usr/bin/env bash
# Build heretic-cli native binaries.
#
#   scripts/build.sh                 # current platform → cli/dist/heretic-cli
#   scripts/build.sh all             # linux-x64 linux-arm64 macos-x64 macos-arm64 windows-x64
#   scripts/build.sh linux macos     # both archs of each OS
#   scripts/build.sh macos-arm64     # one target
#
# Cross-compiling works from any OS (bun downloads the target runtime).
# Output: cli/dist/heretic-cli-<os>-<arch>[.exe] + cli/dist/SHA256SUMS, using
# the asset names `heretic-cli update` looks up in GitHub releases.
#
# Env: OUT_DIR (default cli/dist), BUILD_CWD (directory bun runs in; set it
# when the checkout is on a filesystem where bun's final rename fails, e.g.
# some virtiofs mounts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/cli"
OUT_DIR="${OUT_DIR:-$CLI/dist}"
ENTRY="$CLI/src/index.ts"


# name → bun target
declare_targets() {
    cat <<'EOF'
linux-x64 bun-linux-x64 heretic-cli-linux-x64
linux-arm64 bun-linux-arm64 heretic-cli-linux-arm64
macos-x64 bun-darwin-x64 heretic-cli-macos-x64
macos-arm64 bun-darwin-arm64 heretic-cli-macos-arm64
windows-x64 bun-windows-x64 heretic-cli-windows.exe
EOF
}

selected=()
if [[ $# -eq 0 ]]; then
    selected=(native)
else
    for arg in "$@"; do
        case "$arg" in
            all) selected+=(linux-x64 linux-arm64 macos-x64 macos-arm64 windows-x64) ;;
            linux) selected+=(linux-x64 linux-arm64) ;;
            macos | mac | darwin) selected+=(macos-x64 macos-arm64) ;;
            windows) selected+=(windows-x64) ;;
            native | linux-x64 | linux-arm64 | macos-x64 | macos-arm64 | windows-x64) selected+=("$arg") ;;
            -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
            *) echo "unknown target: $arg (see --help)" >&2; exit 2 ;;
        esac
    done
fi

command -v bun >/dev/null || { echo "bun is not installed: https://bun.sh" >&2; exit 1; }
[[ -d "$CLI/node_modules" ]] || (cd "$CLI" && bun install --frozen-lockfile)
mkdir -p "$OUT_DIR"
# bun writes a temp file in the cwd and renames it onto --outfile, so with
# BUILD_CWD the binary is built there and copied (rename can't cross filesystems).
WORK_DIR="${BUILD_CWD:-$CLI}"
cd "$WORK_DIR"

compile() { # <artifact> [bun build args...]
    local artifact="$1"; shift
    if [[ -n "${BUILD_CWD:-}" ]]; then
        bun build "$ENTRY" --compile "$@" --outfile "$WORK_DIR/$artifact"
        cp "$WORK_DIR/$artifact" "$OUT_DIR/$artifact"
        rm -f "$WORK_DIR/$artifact"
    else
        bun build "$ENTRY" --compile "$@" --outfile "$OUT_DIR/$artifact"
    fi
}

built=()
for name in "${selected[@]}"; do
    if [[ "$name" == native ]]; then
        echo "→ native"
        compile heretic-cli
        "$OUT_DIR/heretic-cli" --version >/dev/null
        continue
    fi
    read -r _ target artifact < <(declare_targets | grep "^$name ")
    echo "→ $name ($target)"
    compile "$artifact" --target="$target"
    built+=("$artifact")
done

if [[ ${#built[@]} -gt 0 ]]; then
    cd "$OUT_DIR"
    if command -v sha256sum >/dev/null; then
        sha256sum -- "${built[@]}" > SHA256SUMS
    else
        shasum -a 256 -- "${built[@]}" > SHA256SUMS   # macOS
    fi
    echo
    cat SHA256SUMS
fi
echo "done → $OUT_DIR"
