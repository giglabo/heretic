---
name: heretic-agents
description: Complete reference for the `heretic-cli agents` command group (list, add, edit, show, validate, delete, mcp) plus the full agent-profile YAML schema, validation rules and error strings, MCP JSON auto-detection formats, masking rules, and editor handling. Use whenever creating/inspecting/validating/deleting heretic agent profiles, adding MCP servers to a profile, reading or writing ~/.heretic/agents/*.yaml, or interpreting an "Invalid profile" / "Profile not found" error.
---

# `heretic-cli agents` — profile management

Profiles live one-per-file in `~/.heretic/agents/<name>.yaml`. The profile *name* is the
filename stem; `loadProfile()` injects `name:` if the file omits it. Source:
`cli/src/commands/agents.ts`, `cli/src/utils/profile-loader.ts`,
`cli/src/types/agent-profile.ts`.

Full field-by-field schema: **`references/profile-schema.md`** in this skill.

```
heretic-cli agents list     [--json]
heretic-cli agents add      <name> [--force]
heretic-cli agents edit     <name> [--editor]
heretic-cli agents show     <name> [--resolved] [--reveal]
heretic-cli agents validate [name]
heretic-cli agents delete   <name> [-f|--force]
heretic-cli agents mcp      <name> [--local] [--file <path>]
```

## `agents list`

Table (aligned, two-space gutter) or `--json`.

```
$ heretic-cli agents list
NAME   IMAGE                          RUNNER  LOCAL
probe  giglabo/claude-heretic:latest  docker  -

$ heretic-cli agents list --json
[{ "name": "probe", "image": "giglabo/claude-heretic:latest", "runner": "docker", "local": false }]
```

- `RUNNER` defaults to `docker` when the profile omits it.
- `LOCAL` is `✓` when the **current directory** has a local override for that profile —
  i.e. `.heretic/cli/<name>.yaml`, or a legacy `.heretic/cli/agent.yaml` whose `extends:`
  matches. `compose.yaml` and `claude-settings.json` are reserved filenames and never
  counted as profiles.
- Invalid profiles are **skipped with a warning**, so a profile missing from `list` is
  usually a validation failure — run `agents validate`.
- Empty state: `No agent profiles found. Run 'heretic-cli agents add <name>' to create one.`
  (or `[]` with `--json`).

## `agents add <name>`

Interactive wizard (inquirer). Exits 1 if the profile exists without `--force`:
`Profile '<name>' already exists. Use --force to overwrite.`

Prompt order and validation:

1. **Docker image** — required, non-empty.
2. **Runner type** — list: Docker / Docker Compose / Custom.
3. **Volumes** — repeating loop: source (required), target (required), read-only (y/N).
4. **Environment variables** — repeating loop: name (`/^[A-Z_][A-Z0-9_]*$/i`), value.
5. **Working directory** — optional.
6. **Command** — optional, space-separated → split on whitespace into an array.
7. **Interactive mode (stdin)?** default yes. **TTY?** default yes.
8. **Network mode** — optional (e.g. `host`) → `extra.network`.
9. **Ports** — repeating loop, must match `^\d+:\d+$` → `extra.ports`.

Then a summary and `Save this profile?` (default yes). Declining prints
`Profile not saved.` and exits 0.

The wizard cannot set `secrets`, `mcp`, `mcp_file`, `git`, `ssh`, `tool_backends`, `dind`,
`claude_settings`, `agent_type`, `provider`, `memory`, `cpus`, `shm_size`, `capabilities`,
`privileged`, `user`, `run_as_root`, `hostname`, or `labels` — use `agents edit --editor`
or write the YAML directly. Note that a profile created here has **no `provider`**, so the
resolver infers `anthropic` (or `copilot` when `agent_type: copilot-cli`).

## `agents edit <name>`

Two modes.

**Interactive (default)** — same prompts as `add`, pre-filled with current values. Volumes,
env, and ports offer `Keep existing` vs `Edit …`; choosing *Edit* **discards the old list**
and starts a fresh add-loop (there is no per-item editing). `name`, `description`, and
`enabled` are preserved; every other field not covered by a prompt is **dropped**.

**`--editor`** — dumps the profile to `${TMPDIR}/heretic-agent-<name>-<epoch>.yaml`, opens
`$EDITOR` (`$VISUAL`, else `vi`), reads it back, parses YAML, validates. On invalid YAML or
a validation error you get `Re-edit` / `Discard changes` (re-edit recurses with your text
preserved). Terminal editors are detected by basename
(`vi vim nvim nano pico emacs micro hx helix ed joe jed ne`); for anything else (GUI
editors that fork) a non-zero exit is tolerated and you are asked to press Enter when done.
The temp file is always unlinked in a `finally` block.

Both modes then print a **change summary** (image, runner, workdir, command, interactive,
tty, volume/env counts, `extra` "modified") and ask `Save changes?`.

`--editor` is the only supported way to hand-edit while keeping validation. Editing
`~/.heretic/agents/<name>.yaml` directly is allowed but unvalidated until you run
`agents validate`.

## `agents show <name>`

Prints YAML.

| Form | Output |
| --- | --- |
| `agents show x` | the raw profile file (plus injected `name:`) |
| `agents show x --resolved` | `ResolvedAgentConfig` after 3-layer merge + `${VAR}` interpolation + secret resolution: `image`, `runner`, `volumes`, `env`, `workdir`, `command`, `interactive`, `tty`, `extra` |
| `+ --reveal` | do not mask sensitive env values |

Masking applies to any env key whose lowercase name **contains** `key`, `token`, `secret`,
or `password`; the value is `maskToken()`-ed (first 8 + `****` + last 4; `****` if < 12 chars).
`--reveal` prints real values — avoid in shared terminals/CI logs.

`--resolved` **executes secret scripts** and reads local overrides from the current
directory, so it is the best pre-flight check before `run`:

```
$ heretic-cli agents show probe --resolved
image: giglabo/claude-heretic:latest
runner: docker
volumes:
  - source: /abs/path/to/cwd      # ${CWD} expanded
    target: /workspace
env: {}
interactive: true
tty: true
```

Note `--resolved` omits `mcp`, `ssh`, `tool_backends`, `git`, `dind`, `secrets`,
`claudeSettings`, `sessionName`, `projectDir` even though the resolver computes them — for
those use `heretic-cli local-validate <profile>`, which prints the *entire* resolved object.

## `agents validate [name]`

Per-profile checklist; with no argument it walks every `*.yaml` in `~/.heretic/agents/`.

```
Validating profile "probe"...
  [pass] YAML syntax
  [pass] Required fields
  [pass] All validation checks passed
```

Exit 1 if any `[fail]`. `[warn]` alone does not fail. The only warning implemented:
`compose section present but runner is "docker". Compose config will be ignored.`
A YAML parse error prints `[fail] YAML syntax: …` and, for a single named profile, exits
immediately (in all-profiles mode it continues with the next file).
A missing named profile: `Profile '<name>' not found` → exit 1.

Validation rules (from `validateProfileDetailed`) — see the reference file for the full
list; the required ones are:

- `image` — required, string.
- `runner` — required, one of `docker | compose | custom`.
- `agent_type` ∈ `claude | aider | copilot-cli | generic`; `provider` ∈ `anthropic | thirdparty | copilot`.
- `volumes[i].source` / `.target` required strings, `.readonly` boolean.
- `extra.ports[i]` must match `^\d+:\d+(\/\w+)?$`.
- `ssh.host` required when `ssh` is present; `mcp[i]` needs `name` plus `command` (stdio)
  or `url` (http); `secrets.*` must be non-empty strings.

`validate` checks **shape only** — it never contacts Docker, never resolves `${VAR}`, and
never runs secret scripts. Absolute-path and sidecar-wiring checks happen later in
`validateResolvedConfig` (see `heretic-local-config`).

## `agents delete <name>`

1. Finds containers labelled `heretic.managed=true` **and** `heretic.agent=<name>`
   (all states; skipped entirely when Docker is unavailable).
2. Lists what will go: containers (name, session, state), the profile path, and associated
   files — `get-<name>-key.sh`, `get-<name>-key.cmd`, `<name>-settings.json`.
3. Confirms (default **No**) unless `-f/--force`.
4. Stops (10 s timeout) + removes each container, warning and continuing on failure; then
   unlinks the profile and each associated file.

```
$ heretic-cli agents delete claude-zai -f
Stopped heretic-claude-zai-default-1a2b3c4d
Removed heretic-claude-zai-default-1a2b3c4d
Deleted profile: /home/you/.heretic/agents/claude-zai.yaml
Deleted secret script: /home/you/.heretic/get-claude-zai-key.sh
Deleted Claude settings: /home/you/.heretic/claude-zai-settings.json

Agent 'claude-zai' deleted.
```

It does **not** delete project-local `.heretic/cli/<name>.yaml`, the `.heretic/temp/*`
session dirs, images, or named cache volumes. Build-sidecar containers are only removed if
they carry `heretic.agent=<name>` (they do), but the per-run network is not — use
`heretic-cli stop --all` first if you care.

## `agents mcp <name>`

Merges MCP server definitions from JSON into a profile (global) or into the project-local
override (`--local`).

```bash
heretic-cli agents mcp claude --file ./mcp.json        # read from file
heretic-cli agents mcp claude                          # opens $EDITOR to paste JSON
heretic-cli agents mcp claude --local --file ./mcp.json  # write to .heretic/cli/claude.yaml
```

Three input shapes are auto-detected (`parseMcpJson`):

```json
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/workspace"] } } }
{ "servers":    { "fs": { "command": "npx", "args": [...] } } }          // VS Code
{ "fs":         { "command": "npx", "args": [...] } }                     // bare map
```

Per entry: transport is `http` when `type: "http"` **or** when no `type` and a string `url`
is present (then `url` is required, `headers` optional); otherwise stdio and `command` is
required (`args` optional). `env` is carried through. Invalid entries throw
`MCP server '<name>' in <source> is missing required field 'command'` and abort.

Then a preview, a confirm, and a **merge by name** (new definitions replace same-named
ones; unrelated servers are kept). Output reports Added / Updated / total.
`--local` creates `.heretic/cli/<name>.yaml` with `extends: <name>` if it doesn't exist.

The profile must exist in `~/.heretic/agents/` even for `--local` (checked first).
`agents mcp` cannot delete a server — edit the YAML and remove the entry.

## Common errors

| Message | Cause |
| --- | --- |
| `Profile not found: <name>` | no `~/.heretic/agents/<name>.yaml` |
| `Invalid profile '<name>': <errors>` | `loadProfile()` validated and rejected the file — every command that loads a profile fails here, including `run` |
| `Failed to load profile '<name>': …` | YAML parse/IO failure |
| `Profile '<name>' not found. Use 'heretic-cli agents list' …` | friendly wrapper printed by `edit`/`show`/`mcp`/`delete` |

## Reference

- `references/profile-schema.md` — every profile field, type, default, which layer may
  override it, and which runner honors it.
