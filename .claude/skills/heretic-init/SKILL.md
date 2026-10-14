---
name: heretic-init
description: Complete reference for `heretic-cli init` — the interactive global setup wizard that writes ~/.heretic/settings.yaml, GitHub/Copilot secret scripts, per-agent Claude settings JSON, and agent profiles for Anthropic / third-party (ZAI, Kimi, custom) / Copilot providers, including every prompt, the exact env vars each provider writes, API-key vs OAuth token handling, model env var sets, and cross-platform script generation. Use when setting up heretic-cli for the first time, changing tokens, adding an agent through the wizard, or debugging which env vars a profile got.
---

# `heretic-cli init` — global setup wizard

One command, two phases:

1. **GitHub tokens** → `~/.heretic/settings.yaml` (+ secret scripts)
2. **Agent profiles** → a loop where you add/delete profiles in `~/.heretic/agents/`

```
heretic-cli init          # no options at all (only -h/--help)
```

It is idempotent and re-runnable: existing token values are shown **masked** and pressing
Enter keeps them. Source: `cli/src/commands/init.ts`.

## Phase 1 — GitHub tokens

Prompts (both optional, Enter to skip):

```
Enter your GitHub token (optional, press Enter to skip):     [default = masked existing]
Enter GitHub Copilot token (optional, press Enter to skip):  [default = masked existing]
```

Masking is `maskToken()`: first 8 chars + `****` + last 4; anything shorter than 12 chars
becomes `****`. **If you submit the masked string unchanged, the existing script path is
kept** — the comparison is literal, so hand-editing the masked default corrupts the token.

For each new token a secret script is written and its **path** (never the raw token) is
stored in settings:

| Platform | File | Content |
| --- | --- | --- |
| Unix | `~/.heretic/get-github-token-key.sh` (mode `0755`) | `#!/bin/bash` + `echo "<token>"` + TODO comments for 1Password / Keychain / pass |
| Windows | `~/.heretic/get-github-token-key.cmd` | `@echo off` + `echo|set /p="<token>"` (no trailing newline) |

Copilot uses `get-copilot-token-key.sh|.cmd`. Resulting settings file:

```yaml
# ~/.heretic/settings.yaml
github:
  token: /home/you/.heretic/get-github-token-key.sh
  copilot_token: /home/you/.heretic/get-copilot-token-key.sh
```

Both fields also accept a **raw token** (backward compatible): `resolveToken()` only
executes the value when it ends in `.sh`, `.cmd`, `.ps1`, `.bat`; otherwise it is used
verbatim. A missing script path logs a warning and falls back to the raw string.

These tokens are injected into *every* container as `GH_TOKEN` and `GITHUB_TOKEN`, and
additionally as `GH_COPILOT_TOKEN` / `GITHUB_COPILOT_TOKEN` when the profile has
`provider: copilot` (falling back to the GitHub token if no Copilot token is set).

## Phase 2 — agent profile loop

```
=== Current Agent Profiles ===
1. claude - giglabo/claude-heretic (docker)

What would you like to do?
  > Add new agent
    Delete agent          (only shown when ≥1 profile exists)
    Done managing agents
```

`Add new agent` first asks the **agent type**:

| Choice | `provider` | `agent_type` | Notes |
| --- | --- | --- | --- |
| Anthropic (direct API) | `anthropic` | `claude` | token optional |
| Third-Party (ZAI, Kimi, or custom) | `thirdparty` | `claude` | token required |
| Copilot (custom API) | `copilot` | `copilot-cli` | token optional (falls back to global Copilot token) |

Profile names are validated with `/^[a-z0-9-_]+$/i` (letters, digits, `-`, `_`).
If `~/.heretic/agents/<name>.yaml` exists you are asked to confirm overwrite.

### Anthropic flow

Prompts: name (default `claude`) → Docker image (default `giglabo/claude-heretic`) →
token (optional) → **token type** (only if a token was given) → optional path to an
existing `settings.json`.

Token type decides the env block:

```yaml
# API Key (API billing)
env:
  ANTHROPIC_API_KEY: ${CLAUDE_API_KEY}     # docker-runner maps → ANTHROPIC_AUTH_TOKEN + ANTHROPIC_AUTH_KEY
```

```yaml
# OAuth Token (Claude subscription)
env:
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_API_KEY}
  ANTHROPIC_AUTH_TOKEN: ""                 # intentionally empty — prevents API fallback
  ANTHROPIC_BASE_URL: ""
```

The empty strings are **preserved** on purpose: the runners strip empty env vars *unless*
the key was explicitly set to `""` in `env`.

### Third-party flow (ZAI / Kimi / custom)

Preset defaults (`THIRDPARTY_PRESET_DEFAULTS`):

| Preset | URL | Model | Small model | Default name |
| --- | --- | --- | --- | --- |
| `zai` | `https://api.z.ai/api/anthropic` | `glm-4.7` | `glm-4.5-air` | `claude-zai` |
| `kimi` | `https://api.moonshot.ai/anthropic` | `kimi-k2.5` | `kimi-k2.5` | `claude-kimi` |
| `custom` | *(you type it; validated with `new URL()`)* | — | — | `claude-thirdparty` |

All three seed these env defaults: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`API_TIMEOUT_MS=600000`. You then choose **Keep defaults / Modify default values / Add
more env vars**, with a free-form "empty name to finish" loop for extras
(names validated `/^[A-Z_][A-Z0-9_]*$/i`).

Then **where model config lives**:

- `Environment Variables (in agent profile YAML)` → six env vars written into the profile.
- `Settings JSON (in Claude settings file)` → the same six go into `env` inside
  `~/.heretic/<name>-settings.json`; optionally point at an existing settings.json instead
  (the file must exist; `~` is expanded).

The six model variables:

```
main  : ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL      → primary model
small : ANTHROPIC_SMALL_FAST_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, CLAUDE_CODE_SUBAGENT_MODEL → small/fast model
```

If the small model is left blank it falls back to the primary model. Resulting profile env:

```yaml
env:
  ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
  ANTHROPIC_API_KEY: ${CLAUDE_ZAI_API_KEY}
  ANTHROPIC_MODEL: glm-4.7
  ANTHROPIC_DEFAULT_OPUS_MODEL: glm-4.7
  ANTHROPIC_DEFAULT_SONNET_MODEL: glm-4.7
  ANTHROPIC_SMALL_FAST_MODEL: glm-4.5-air
  ANTHROPIC_DEFAULT_HAIKU_MODEL: glm-4.5-air
  CLAUDE_CODE_SUBAGENT_MODEL: glm-4.5-air
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  API_TIMEOUT_MS: "600000"
```

### Copilot flow

Prompts: name (default `copilot`) → Docker image (**required**, no default) → optional
dedicated token. With a dedicated token the profile gets `<NAME>_TOKEN: ${<NAME>_API_KEY}`;
without one, nothing is written and the container relies on the global
`GH_COPILOT_TOKEN`/`GITHUB_COPILOT_TOKEN` injection. No Claude settings file is created
for Copilot agents.

## What every created profile looks like

```yaml
image: giglabo/claude-heretic
runner: docker
agent_type: claude            # copilot-cli when provider is copilot
provider: anthropic           # anthropic | thirdparty | copilot
description: Anthropic agent  # or "Third-party agent (zai)" / "Copilot agent"
interactive: true
tty: true
volumes:
  - source: ${CWD}
    target: /workspace
workdir: /workspace
env: {}                       # provider-specific, see above
claude_settings: /home/you/.heretic/claude-settings.json   # omitted for copilot
secrets:
  CLAUDE_API_KEY: /home/you/.heretic/get-claude-key.sh     # only when a token was given
```

The secret env-var name is derived mechanically:
`name.toUpperCase().replace(/-/g,"_") + "_API_KEY"` (so `claude-zai` → `CLAUDE_ZAI_API_KEY`).
Secret keys that are *not* also present in `env` are resolved but **not** exported into the
container — they exist only to be interpolated as `${...}` inside `env`.

## Default Claude settings file

When no existing `settings.json` is supplied, `~/.heretic/<name>-settings.json` is:

```json
{
  "permissions": {
    "allow": ["Read", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "mcp__*"]
  },
  "model": "opus"
}
```

At run time this is merged with the project's `.heretic/cli/claude-settings.json`
(arrays unioned, objects shallow-merged, local wins) into
`.heretic/temp/<session>/settings.json`, which the container sees as `~/.claude/settings.json`.

## Delete inside the wizard vs `agents delete`

The wizard's delete removes only three paths and never touches containers:
`~/.heretic/agents/<name>.yaml`, `~/.heretic/get-<name>-key.sh`, `~/.heretic/<name>-settings.json`.
It does **not** remove `.cmd` scripts (Windows) — use `heretic-cli agents delete <name>`,
which also stops/removes the agent's containers and handles both script variants.

## Final summary

```
=== Configuration Complete ===
GitHub Token: ghp_xxxx****abcd
GitHub Copilot Token: (not configured)

Agent Profiles: 2
  - claude
  - claude-zai

Run an agent with: heretic-cli <profile-name>
```

## Gotchas

- **Everything is interactive.** There are no flags; `init` cannot be scripted or run in
  CI. For automation, write `~/.heretic/settings.yaml` and `~/.heretic/agents/*.yaml`
  directly, then verify with `heretic-cli agents validate`.
- Tokens are stored **in plaintext inside the generated script**. The script is a
  deliberate seam: replace its body with `op read`, `security find-generic-password`, or
  `pass show` and nothing else changes.
- On Windows only `.cmd` is generated; `.ps1` works too but you must create it yourself
  (`interpolation.ts` runs `.ps1` via `powershell -ExecutionPolicy Bypass -File`).
- `init` never creates local project config — that is `heretic-cli local-init`.
- Directories are created up front (`ensureSettingsDir()`, `ensureProfilesDir()`), so a
  cancelled wizard can still leave an empty `~/.heretic/agents/`.
- A secret script that prints nothing logs `Secret script returned empty value` (warning,
  not an error) and the env var ends up empty — then gets stripped by the runner.
