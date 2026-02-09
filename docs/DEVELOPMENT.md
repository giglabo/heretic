# Development

## Prerequisites

- [Bun](https://bun.sh/) (latest)
- [Docker](https://www.docker.com/) (for running agents)
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) (for secret scanning)

## Getting Started

```bash
git clone https://github.com/giglabo/heretic.git
cd heretic

# Install git hooks (secret scanning on commit)
./scripts/install-hooks.sh

# Install dependencies
cd cli && bun install
```

## Common Commands

All commands run from the `cli/` directory:

```bash
bun run dev              # Run CLI in dev mode
bun run dev -- <args>    # Run with arguments (e.g. bun run dev -- init)
bun test                 # Run all tests
bun run lint             # ESLint check
bun run format           # Prettier format
bun run build            # Build native executable
```

## Secret Scanning

This repo uses [gitleaks](https://github.com/gitleaks/gitleaks) to prevent secrets from being committed.

**Pre-commit hook** — automatically scans staged changes before every commit. Installed via `./scripts/install-hooks.sh` (sets `core.hooksPath` to `.githooks/`).

**CI** — the `secrets` job in GitHub Actions runs a full history scan on every push and PR.

Install gitleaks locally:

```bash
brew install gitleaks        # macOS
scoop install gitleaks       # Windows
```

Configuration is in `.gitleaks.toml`. To add allowlist entries for new test fixtures, add the placeholder value to the `regexes` list under `[allowlist]`.
