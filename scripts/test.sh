#!/usr/bin/env bash
# Run the checks CI runs.
#
#   scripts/test.sh            # format:check + lint + unit tests (any OS)
#   scripts/test.sh --e2e      # + SSH e2e against a private sshd (Linux, uses sudo;
#                              #   creates a throw-away user, starts sshd on :2222)
#   scripts/test.sh --docker-host [args]
#                              # + real container → this machine over SSH
#                              #   (Linux or macOS with Docker; see test-ssh-docker-host.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/cli"

[[ -d node_modules ]] || bun install --frozen-lockfile

echo "== format:check"; bun run format:check
echo "== lint";         bun run lint
echo "== unit tests";   bun test

case "${1:-}" in
    --e2e)
        command -v shellcheck >/dev/null && shellcheck -S warning src/templates/assets/ssh-exec tests/e2e/ssh-e2e.sh
        "$ROOT/scripts/build.sh"
        echo "== SSH e2e (sudo)"
        sudo env HERETIC_CLI="$ROOT/cli/dist/heretic-cli" bash tests/e2e/ssh-e2e.sh
        ;;
    --docker-host)
        shift
        "$ROOT/scripts/build.sh"
        "$ROOT/scripts/test-ssh-docker-host.sh" --cli "$ROOT/cli/dist/heretic-cli" "$@"
        ;;
    "") ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
esac
echo "all checks passed"
