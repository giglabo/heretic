---
name: heretic-doctor
description: Complete reference for `heretic-cli doctor` — all ten environment health checks in order, exact pass/warn/fail/skip messages, what `--fix` actually repairs, the summary line and exit codes, plus the confirmed Map-vs-Object bug that makes the profile and image checks silently vacuous. Use when running heretic-cli diagnostics, interpreting doctor output, or explaining why doctor reports "0 profile(s) validated" despite existing profiles.
---

# `heretic-cli doctor` — environment health checks

```
heretic-cli doctor [--fix]
```

Runs ten checks in a fixed order, prints one line per check, then a summary.
Source: `cli/src/commands/doctor.ts`.

Statuses: `[pass]`, `[warn]`, `[fail]`, `[skip]`. **Only `[fail]` affects the exit code.**

## The ten checks

| # | Name | pass | warn | fail |
| --- | --- | --- | --- | --- |
| 1 | Docker daemon | `Docker daemon is running` | — | `Docker daemon is not running` / `Failed to check Docker: …` |
| 2 | Docker version | `Docker version <v> (API <api>)` when API ≥ 1.41 | — | API < 1.41 (`… is too old (minimum: 1.41)`) or `Failed to get Docker version: …` |
| 3 | Docker Compose | `Docker Compose is available` (`docker compose version` exit 0) | `Docker Compose not available (optional for most operations)` | — |
| 4 | Config directory | `<~/.heretic> exists`; with `--fix`: `Created <dir>` | missing (`… does not exist (use --fix to create)`) or `Failed to create …` | — |
| 5 | Settings file | `<~/.heretic/settings.yaml> is valid` | `… missing or invalid (will use defaults)` | — |
| 6 | Global profiles | `<n> profile(s) validated` | — | `Invalid profiles found: …` / `Failed to load profiles: …` |
| 7 | Local config | `<n> local config(s) valid: a, b` | — | `Local config validation failed: …` |
| 8 | Required images | `All required images are available`; with `--fix`: `Pulled <n> missing image(s)` | `Missing <n> image(s): … (use --fix to pull)`, `Some images failed to pull`, `Failed to check images: …` | — |
| 9 | Network connectivity | `Docker Hub is reachable` (HTTP 200 **or 401** from `https://registry-1.docker.io/v2/`, 5 s timeout) | `Docker Hub returned status <n>` / `Unable to reach Docker Hub (may affect image pulls)` | — |
| 10 | Volume paths | `All volume source paths exist` | `Non-existent paths found: …` / `Failed to check volume paths: …` | — |

Check 7 skips with `No local config in current directory` when `.heretic/cli/` has no
profile configs. It resolves **each** local profile (`resolveConfig` → executes secret
scripts) and runs `validateResolvedConfig`, so a broken local override shows up here as a
`[fail]` — including the classic all-comments `local-init` template
(`Invalid config: expected an object`).

Check 10 skips volume sources that begin with `${` (uninterpolated variables) for global
profiles, and additionally checks the interpolated sources of local configs.

Summary and exit:

```
Summary: 6 passed, 1 warnings, 2 failed
```

`process.exit(failed > 0 ? 1 : 0)`. Warnings never fail the command — safe to gate CI on
`doctor` only if you also grep for `[warn]`.

## What `--fix` actually does

Exactly two things:

1. **Creates `~/.heretic/`** (recursive `mkdirSync`) when check 4 finds it missing.
2. **Pulls missing images** referenced by global profiles (check 8), logging
   `✓ Pulled <image>` / `✗ Failed to pull <image>: …` per image.

`--fix` does **not**: start Docker, install Compose, create `settings.yaml`, repair invalid
profiles, fix local configs, create missing volume source directories, or set permissions.

## ⚠ Confirmed bug: checks 6, 8 and 10 are vacuous for global profiles

`loadAllProfiles()` returns a **`Map`**, but doctor iterates it with
`Object.entries(profiles)`, which yields `[]` for a Map. Therefore:

- Check 6 always reports `[pass] 0 profile(s) validated` — even with many valid profiles,
  and it can never report an invalid one.
- Check 8 builds an empty `requiredImages` set, so it always reports
  `All required images are available` and `--fix` never pulls anything.
- Check 10's global-profile loop never executes (its local-config loop still works).

Reproduced with one valid profile present:

```
$ heretic-cli doctor
[fail] Docker daemon is not running
[fail] Failed to get Docker version: Was there a typo in the url or port?
[pass] Docker Compose is available
[pass] /home/agent/.heretic exists
[pass] /home/agent/.heretic/settings.yaml is valid
[pass] 0 profile(s) validated        ← one profile exists and is valid
[skip] No local config in current directory
[warn] Failed to check images: …
[pass] Docker Hub is reachable
[pass] All volume source paths exist ← nothing was actually checked
Summary: 6 passed, 1 warnings, 2 failed
```

**Until this is fixed, use these instead:**

```bash
heretic-cli agents validate            # real profile validation (exit 1 on error)
heretic-cli local-validate             # real local-config validation + resolved dump
docker images                          # confirm profile images exist
heretic-cli agents show <x> --resolved  # confirm interpolation/volume paths
```

The one-line repair (for whoever fixes it) is to iterate the Map:
`for (const [name, profile] of profiles)` in checks 6, 8 and 10 — or wrap with
`Object.fromEntries(profiles)`.

## Notes

- Docker checks use dockerode's `ping()`/`version()`; the "Was there a typo in the url or
  port?" text is dockerode's own connection error surfacing through the message.
- The Compose check shells out to `docker compose version` via `Bun.spawn`, so it needs the
  **docker CLI**, not just the socket.
- Check 9 treats HTTP 401 as success (the registry's expected unauthenticated answer).
- Output goes through the pino logger at info level, so `--log-file <path>` captures a full
  doctor run for bug reports.
- `doctor` never writes anything except with `--fix` (mkdir + image pulls).
