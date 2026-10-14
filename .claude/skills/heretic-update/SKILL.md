---
name: heretic-update
description: Complete reference for `heretic-cli update` and the two-phase self-update mechanism — GitHub release lookup, semver comparison, platform asset naming, staging as .heretic-cli.pending, applying it on next startup with backup/rollback, npm/bun install detection, system-directory permission handling, and every failure path. Use when updating heretic-cli, debugging a stuck or failed update, or explaining why update says "installed via npm".
---

# `heretic-cli update` — two-phase self-update

```
heretic-cli update      # no flags (a --check flag is commented out in the source)
```

Source: `cli/src/commands/update.ts`. Repo constant: `GITHUB_REPO = "giglabo/heretic"`;
staged file name: `.heretic-cli.pending`.

A running executable cannot overwrite itself, so the update is split:

```
Phase 1  `heretic-cli update`      → download the new binary → write <exeDir>/.heretic-cli.pending (0755)
Phase 2  next `heretic-cli …` run  → applyPendingUpdate() renames exe → exe.backup, pending → exe, chmod 0755, deletes backup, exit 0
```

Phase 2 runs **before Commander parses anything** (`cli/src/index.ts` awaits
`applyPendingUpdate()` first). When it applies an update the process prints
`Update applied successfully!` and **exits 0 without running your command** — re-run it.

## Phase 1 in detail

1. **npm/bun install detection** — if `resolve(process.argv[1])` contains `node_modules` or
   ends in `.js`, no binary update is attempted:

   ```
   Current version: 0.1.0
   This CLI was installed via npm/bun. To update, run:

     bun update -g heretic-cli
   ```

2. **System-directory check** — if the executable lives under `/usr/bin`, `/usr/local/bin`,
   `/bin`, `/sbin`, `/usr/sbin`, `/opt` (Unix) or `%ProgramFiles%`, `%ProgramFiles(x86)%`,
   `%windir%`, `%SystemRoot%` (Windows), it warns
   `CLI is installed in a system directory` and probes writability by creating and deleting
   `.heretic-write-test-<epoch>`. Not writable →
   `Cannot update: insufficient permissions` +
   `Please run with sudo or reinstall in a user directory (e.g., ~/.local/bin)`, then returns
   (**exit code 0** — the failure is logged, not thrown).

3. **Release lookup** — `GET https://api.github.com/repos/giglabo/heretic/releases/latest`
   with `Accept: application/vnd.github.v3+json`, `User-Agent: heretic-cli`. Non-OK →
   `GitHub API returned status <n>` then `Could not fetch latest release information`.
   The request is unauthenticated, so it is subject to GitHub's 60 req/h/IP rate limit.

4. **Version comparison** — `compareVersions` strips a leading `v` and compares numeric parts
   (missing parts = 0). Not newer → `You are already on the latest version!`.
   Pre-release/build suffixes are **not** understood: `Number("0-rc1")` is `NaN`, which
   compares as neither greater nor less, so a `v1.0.0-rc1` tag is treated as *not newer*.

5. **Asset selection** — the release must contain an asset named exactly:

   ```
   heretic-cli-<darwin|linux|windows>-<x64|arm64>[.exe]
   ```

   (`.exe` only on Windows.) Unsupported platform/arch →
   `Unsupported platform: <platform> <arch>`. No matching asset →
   `Could not find asset for <name>` (available assets logged at debug).

6. **Download and stage** — fetch `browser_download_url`, write the whole body to
   `<exeDir>/.heretic-cli.pending`, `chmod 0755`. Partial downloads are unlinked on error.
   Success:

   ```
   Update staged successfully!
   Restart the CLI to apply the update

   Update downloaded and staged successfully!
   Run any heretic-cli command to apply the update
   ```

   The download is streamed into memory (`arrayBuffer()`), so a ~100 MB binary needs that
   much RAM, and there is **no checksum or signature verification**.

## Phase 2 in detail

`applyPendingUpdate()` (skipped entirely for npm installs):

1. No `.heretic-cli.pending` next to the exe → return false silently (debug log only).
2. Writability re-check; not writable → `Cannot apply update: insufficient permissions`,
   `Please run with sudo or reinstall in a user directory`, **the pending file is deleted**,
   return false. (So an update staged as a normal user but landing in a root-owned dir is
   discarded, not retried.)
3. `rename(exe, exe.backup)` (deleting a pre-existing backup first).
4. `rename(pending, exe)` + `chmod 0755` → `Update applied successfully!`, then the backup is
   deleted (failure to delete is only a debug log).
5. On any error: restore from `exe.backup` if present (`Restored from backup`), clean up the
   pending file, return false.

Both phases assume the pending file sits in the **same directory** as the executable, so a
CLI on a read-only mount or in a container layer can never self-update.

## Version reporting

`-v` / `--version` prints the compiled-in `version` from `cli/package.json` (`0.1.0`) and
exits 0. There is no `--check`-only mode: the flag exists in the source as a comment. To poll
without staging anything, query the API yourself:

```bash
curl -s https://api.github.com/repos/giglabo/heretic/releases/latest | jq -r .tag_name
heretic-cli --version
```

## Manual recovery

```bash
which heretic-cli                 # locate the binary
ls -la "$(dirname "$(which heretic-cli)")" | grep -E 'pending|backup'
rm -f <exeDir>/.heretic-cli.pending          # abandon a staged update
mv <exeDir>/heretic-cli.backup <exeDir>/heretic-cli   # roll back a bad apply
```

## Local builds vs releases

If you build from source (`cd cli && bun run build` → `dist/heretic-cli`), `update` will
happily replace your locally built binary with the latest **release** asset — losing local
changes. Keep dev builds outside your PATH, or accept the overwrite.

Note for this repo's sandbox-style environments: `bun run build` can fail to rename on
virtiofs mounts; build from an overlayfs cwd and copy the artifact into `cli/dist/`.

## Gotchas

- Updates are **latest-release only** — no pinning, no downgrade, no channel selection.
- No integrity check on the downloaded asset.
- Asset names must match the exact pattern; a release that publishes
  `heretic-cli-linux-amd64` (instead of `-x64`) is invisible to the updater.
- All failures in `runUpdate()` return normally, so `heretic-cli update` almost always exits
  **0** — check the log lines, not the exit code, in scripts.
- The first command after staging is consumed by the apply step; CI should run
  `heretic-cli --version` once before real work.
