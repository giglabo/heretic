#!/usr/bin/env bash
#
# Configure git to use the project's .githooks/ directory for hooks.
# Run once after cloning the repo.
#
# Usage:
#   ./scripts/install-hooks.sh
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Configuring git hooks path → .githooks/"
git -C "$REPO_ROOT" config core.hooksPath .githooks

echo "Done. Pre-commit secret scanning is now active."

# Check if gitleaks is available
if ! command -v gitleaks &>/dev/null; then
  echo ""
  echo "NOTE: gitleaks is not installed yet. Install it for secret detection:"
  echo "  brew install gitleaks          # macOS"
  echo "  scoop install gitleaks         # Windows"
  echo "  https://github.com/gitleaks/gitleaks#installing"
fi
