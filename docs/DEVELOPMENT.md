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

Repository scripts (run from anywhere): `scripts/build.sh`, `scripts/test.sh`,
`scripts/test-ssh-docker-host.sh`, `scripts/release.sh` — see below.

## Building

`heretic-cli` ships as a single native binary per platform, compiled with
`bun build --compile`. Cross-compiling works from any OS — bun downloads the
target runtime.

```bash
scripts/build.sh                 # this machine → cli/dist/heretic-cli
scripts/build.sh linux macos     # linux-x64, linux-arm64, macos-x64, macos-arm64
scripts/build.sh all             # + windows-x64
scripts/build.sh macos-arm64     # a single target
```

Outputs land in `cli/dist/` with the release asset names and a `SHA256SUMS`:

| Target | File |
|--------|------|
| Linux x64 / arm64 | `heretic-cli-linux-x64`, `heretic-cli-linux-arm64` |
| macOS Intel / Apple Silicon | `heretic-cli-macos-x64`, `heretic-cli-macos-arm64` |
| Windows x64 | `heretic-cli-windows.exe` |

Keep these names: `heretic-cli update` downloads the asset by exact name.
Static assets (`entrypoint.sh`, `ssh-exec`, `sidecar-exec`, the Go exec-server
source) are embedded at build time — a change to any of them needs a rebuild.

If the checkout lives on a filesystem where bun's final rename fails (some VM
shares: `EXDEV`/`ENOENT` on `.bun-build`), set `BUILD_CWD` to a local directory:
`BUILD_CWD=/tmp scripts/build.sh`.

`bun run bundle` builds the npm package (`dist/heretic-cli.js`, needs Bun at runtime).

## Testing

| Layer | Command | Runs where | Covers |
|-------|---------|------------|--------|
| Static + unit | `scripts/test.sh` | any OS | format, lint, ~590 `bun test` tests (runners, config, ssh-exec against a fake `ssh`) |
| SSH e2e | `scripts/test.sh --e2e` | Linux, sudo | private sshd + throw-away user: path mapping, quoting, exit codes, host keys, key modes, 40 parallel calls, orphan kill, `ssh setup`/`check` |
| Docker-host | `scripts/test.sh --docker-host [--port N]` | Linux or **macOS**, Docker | the real thing as you: Linux container → this machine over SSH (below) |

### Linux container against a Mac (or Linux) host

`scripts/test-ssh-docker-host.sh` reproduces what a user does on their own machine:

```bash
scripts/build.sh
scripts/test-ssh-docker-host.sh                 # sshd on :22, Docker running
scripts/test-ssh-docker-host.sh --no-container  # host side only (no Docker)
scripts/test-ssh-docker-host.sh --port 2222 --keep
```

1. creates a throw-away profile and a small C project under `~/.heretic/e2e/`
2. `heretic-cli ssh setup` — key, `authorized_keys` line, pinned host key, PATH, presets
3. `heretic-cli ssh check`
4. host side: the embedded `ssh-exec` builds the project with the host's `make`/`cc`,
   checks the binary format (**Mach-O on macOS**), and that `auto-run`/`host-run` route it
   to the host; interrupt cleanup; 20 parallel calls
5. container side: `ssh check --container`, then `heretic-cli ssh exec` runs `make` and
   `auto-run ./hello` from a **Linux container** — on a Mac it must print `hello from Darwin`

Everything it adds — profile, keys, the `authorized_keys` line, files — is removed at
exit (`--keep` leaves it for debugging). It is bash 3.2 compatible (macOS `/bin/bash`).

Prerequisites on a Mac: **Remote Login** on (System Settings → General → Sharing) and
Docker Desktop. On Linux: `openssh-server` listening on the Docker bridge too.

Verified on a real setup (Linux container on Docker Desktop → Apple Silicon Mac, macOS 26,
directory user `name@company.com`, `/bin/bash` 3.2 login shell): `make`/`cc` produce a Mach-O
on the Mac, `cargo build --release` with a container `--manifest-path` builds there and
`auto-run` runs the result on the Mac; 20 parallel calls pass; an interrupted command is
killed on the Mac; ~40 ms per call with the captured PATH, ~0.5 s with a login shell.

Any profile can be poked the same way by hand:

```bash
heretic-cli ssh exec <profile> -- uname -s            # Linux (the container)
heretic-cli ssh exec <profile> -- host-run uname -s   # Darwin (the host)
```

### What CI runs (`.github/workflows/ci.yml`)

On every push to `main` / `feat/**` and every PR to `main`:

| Job | What |
|-----|------|
| `secrets` | gitleaks over the full history |
| `lint`, `test`, `bundle` | format check, ESLint, `bun test`, npm bundle |
| `binaries` | cross-compiles all five release binaries (artifacts kept 7 days) |
| `smoke` | builds and runs the binary on Ubuntu, macOS and Windows |
| `ssh-e2e` | `tests/e2e/ssh-e2e.sh` incl. a real container reaching the runner via `host-gateway`, then `test-ssh-docker-host.sh` as the regular runner user |
| `ssh-macos-host` | the host half on an Apple Silicon macOS runner: macOS sshd, BSD userland, a real Mach-O from `cc` and its routing |
| `ssh-docker-host-macos` | the full pairing on an Intel macOS runner: colima runs the Linux container, which builds and runs on the Mac over SSH (`test-ssh-docker-host.sh`, ~15 min) |
| `exec-server` | `go vet` + build of the sidecar exec-server |

Apple Silicon hosted macOS runners cannot run Linux containers (no nested virtualization);
Intel ones (`macos-15-intel`) can, with colima, so `ssh-docker-host-macos` runs the literal
*Linux container → Mac host* pairing in CI. Docker Desktop and colima both route
`host-gateway` to the Mac, which is what `ssh.host: docker-host` relies on.

## Releasing

```bash
scripts/release.sh 0.2.0          # tests, builds all targets, bumps cli/package.json, commits, tags v0.2.0
scripts/release.sh 0.2.0 --push   # ... and pushes branch + tag
```

The `v*` tag triggers `.github/workflows/release.yml`:

| Job | Result |
|-----|--------|
| `verify` | fails unless the tag equals `cli/package.json`'s version |
| `build-binaries` | the five `heretic-cli-*` binaries (native runners) |
| `exec-server` | `exec-server-{linux,darwin}-{amd64,arm64}` (static Go) |
| `publish-release` | GitHub release with every binary + `SHA256SUMS` |
| `publish-npm` | `@giglabo/heretic-cli` — needs the `NPM_TOKEN` secret; independent of the binaries |

Users upgrade with `heretic-cli update` (downloads `heretic-cli-<os>-<arch>` from the latest
release and applies it on the next start). Verify a download with
`sha256sum -c SHA256SUMS --ignore-missing` (`shasum -a 256 -c` on macOS).

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
