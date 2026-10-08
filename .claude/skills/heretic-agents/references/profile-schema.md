# Agent profile YAML — complete schema

File: `~/.heretic/agents/<name>.yaml` (global) and `.heretic/cli/<name>.yaml` (local
override, same schema plus `extends:`). Types from `cli/src/types/agent-profile.ts`;
validation from `validateProfileDetailed()` (shape) and `validateResolvedConfig()`
(post-merge semantics).

## Top level

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `image` | string | **yes** | — | Docker image; trimmed; pulled automatically if missing locally |
| `runner` | `docker` \| `compose` \| `custom` | **yes** (validator) | `docker` (resolver) | `validateProfileDetailed` errors when absent; `resolveConfig` still defaults it |
| `agent_type` | `claude` \| `aider` \| `copilot-cli` \| `generic` | no | `claude` | drives MCP mount paths and which home dir is mounted |
| `provider` | `anthropic` \| `thirdparty` \| `copilot` | no | inferred: `copilot-cli`→`copilot`, else `anthropic` | only `copilot` gets Copilot token injection |
| `volumes` | `VolumeMount[]` | no | `[]` | see below; sources must be **absolute after interpolation** |
| `env` | map<string,string> | no | `{}` | values must be strings; `${VAR}` interpolated |
| `workdir` | string | no | `""` | container `WorkingDir` / compose `working_dir` |
| `command` | string \| string[] | no | `[]` | normalized to an array; overrides image `CMD` |
| `interactive` | boolean | no | `true` | `OpenStdin`/`AttachStdin`; compose `stdin_open` |
| `tty` | boolean | no | `true` | `Tty` / compose `tty` |
| `extra` | `AgentProfileExtra` | no | `{}` | Docker knobs, see below |
| `compose` | `ComposeConfig` | no | — | only used by the `compose` runner (warning otherwise) |
| `ssh` | `SshConfig` | no | — | SSH tool-execution backend |
| `tool_backends` | `ToolBackends` | no | — | HTTP build sidecars (see `heretic-sidecars`) |
| `mcp` | `McpServer[]` | no | — | inline MCP servers |
| `mcp_file` | string | no | — | path to JSON with MCP servers (`~` expanded); merged under inline `mcp` |
| `mcp_override` | boolean | no | `false` | mount generated MCP config even when the workspace already has a usable one |
| `git` | `GitConfig` | no | — | token + author identity |
| `dind` | boolean | no | `false` | bind-mounts the host Docker socket |
| `secrets` | map<string,string> | no | — | env-var name → script path / `$ENV_REF` / literal |
| `claude_settings` | string | no | — | path to a Claude Code `settings.json` (`~` expanded) |
| `name` | string | no | filename stem | auto-injected on load |
| `description` | string | no | — | free text |
| `enabled` | boolean | no | — | **stored and preserved but never enforced** by any command |

## `volumes[]` (`VolumeMount`)

```yaml
volumes:
  - source: ${CWD}          # host path; ${VAR} allowed; must be absolute after interpolation
    target: /workspace      # container path
    readonly: false         # optional → appends ":ro"
```

`validateResolvedConfig` errors: `Volume[i].source must be non-empty`,
`Volume[i].source must be an absolute path: …`, `Volume[i].target must be non-empty`.

Local overrides **replace the whole array** — they never merge element-wise.

## `extra` (`AgentProfileExtra`)

| Key | Type | docker runner | compose runner |
| --- | --- | --- | --- |
| `network` | string | `HostConfig.NetworkMode` | `network_mode` |
| `ports` | string[] `"host:container"` (validator also allows `/proto`) | `PortBindings` (`"8080"` → same port both sides; `"8080:80"` → mapped; more colons throw `Invalid port format`) | `ports:` verbatim |
| `capabilities` | string[] | `CapAdd` | `cap_add` |
| `privileged` | boolean | `Privileged` | `privileged` |
| `user` | string `"uid:gid"` | `User` | `user` |
| `run_as_root` | boolean | forces `User: root`, sets `HERETIC_RUN_AS_ROOT=1`, bind-mounts the embedded entrypoint over `/entrypoint.sh` | same, via `user: root` + volume |
| `hostname` | string | `Hostname` | `hostname` |
| `memory` | string `4g`/`512m`/`1024k`/bytes | parsed to bytes → `Memory` | `deploy.resources.limits.memory` (string) |
| `cpus` | string `"2.0"` | `NanoCpus` = cpus × 1e9 | `deploy.resources.limits.cpus` |
| `shm_size` | string | parsed to bytes → `ShmSize` | `shm_size` |
| `labels` | map<string,string> | merged **after** heretic labels (can override them) | same |

`parseMemory` accepts `^(\d+(\.\d+)?)(b|k|m|g)?$` (case-insensitive); anything else throws
`Invalid memory format: <v>`. `parseCpus` throws `Invalid CPU value: <v>` on NaN.
Compose ignores `memory`/`cpus` unless the deploy schema is honored by your compose
version — `shm_size` is emitted separately and always applies.

## `ssh` (`SshConfig`)

```yaml
ssh:
  host: dev-box.internal        # required, non-empty
  port: 22                      # optional number, 1–65535
  user: agent                   # optional, default "agent"
  key_path: /home/you/.ssh/id_rsa   # optional, must be ABSOLUTE; bind-mounted read-only to /home/agent/.ssh/id_rsa
  host_cwd: /home/agent/work    # optional working dir on the remote
```

Exports `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY_PATH`, `SSH_HOST_CWD` into the
container; the entrypoint then generates `ssh-exec` wrappers for missing toolchain
commands. Merged **shallowly** by local overrides (per-key).

## `tool_backends` (`ToolBackends`)

```yaml
tool_backends:
  sidecars:
    - runtime: node                 # node|python|java|go|rust ONLY
      image: heretic-builder-node:latest
      port: 8080                    # optional, 1–65535, default 8080
      command: ["exec-server", "-port", "8080", "-cwd", "/workspace"]   # optional override
      env: { NPM_CONFIG_FUND: "false" }
      env_passthrough: ["NPM_TOKEN"] # allowlist forwarded per-exec
      cache_volumes: ["node-cache:/home/builder/.npm"]
      healthcheck: { test: [...] }   # raw compose healthcheck override
  workspace_target: /workspace       # default; MUST match one volume target
  ready_timeout: 60                  # seconds, ≥1
  run_as_caller_uid: true            # default true
```

Post-merge validation errors: invalid runtime, duplicate runtime, empty image, port out of
range, `ready_timeout < 1`, and *no volume targets `<workspace_target>`*. A warning is
logged when both `sidecars` and `ssh` are configured (a build would span two filesystems).
`sidecars` **replaces** on override; scalar keys merge.

## `mcp[]` (`McpServer`)

```yaml
mcp:
  - name: filesystem            # required
    command: npx                # required for stdio (default transport)
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    env: { FOO: bar }
  - name: remote
    type: http                  # requires url
    url: https://mcp.example.com/sse
    headers: { Authorization: "Bearer ${TOKEN}" }
```

The array **replaces** on override. `mcp_file` servers form the base and inline `mcp`
entries override/append by name. Generated file is written to
`.heretic/temp/<session>/.mcp.json` in `{"mcpServers": {…}}` shape and bind-mounted to:

| `agent_type` | mount target(s) |
| --- | --- |
| `claude`, `aider`, `generic` | `/workspace/.mcp.json` |
| `copilot-cli` | `/root/.copilot/mcp-config.json` **and** `/home/agent/.copilot/mcp-config.json` (each entry also gets `type: "stdio"` if absent and `tools: ["*"]`) |

Mounting is **skipped** when the workspace already has a usable config
(`<project>/.mcp.json`, or `<project>/.copilot/mcp-config.json` for copilot) — "usable"
means parseable JSON with a non-empty `mcpServers` object. A 0-byte or broken file counts
as absent. `mcp_override: true` forces the mount.

## `git` (`GitConfig`)

```yaml
git:
  token: ${GH_TOKEN}            # overrides the global settings token → GH_TOKEN + GITHUB_TOKEN
  author_name: Heretic Agent    # → GIT_AUTHOR_NAME
  author_email: agent@example.com  # → GIT_AUTHOR_EMAIL
```

Merged shallowly by overrides. Empty-string `token` is a validation error
(`git.token must be non-empty when specified`).

## `secrets`

```yaml
secrets:
  CLAUDE_API_KEY: ~/.heretic/get-claude-key.sh   # script → stdout (trimmed)
  ZAI_KEY: $ZAI_TOKEN                            # env-var reference ($VAR or ${VAR})
  PLAIN: sk-literal-value                        # used as-is
```

Mode detection: ends in `.sh|.cmd|.ps1|.bat` → executed (30 s timeout; `~` expanded; on
Windows `.sh`→bash, `.ps1`→powershell, `.cmd`/`.bat`→cmd.exe); matches
`^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$` → `process.env` lookup (**throws** if unset); otherwise
literal. Failures are fatal: `Secret script not found: …`, `Secret script failed (…): …`,
`Secret "X": environment variable "Y" is not set`.

Resolved secrets are merged into the interpolation context, so `env` can reference them as
`${CLAUDE_API_KEY}`. A secret key that never appears in `env` is **not** exported to the
container (docker runner filters `secretKeys - envKeys`); the compose and custom runners
are less strict and pass the whole map into the service environment.

## Env transformations applied at run time

| Input | Result in container |
| --- | --- |
| `ANTHROPIC_API_KEY: X` | `ANTHROPIC_AUTH_TOKEN=X` **and** `ANTHROPIC_AUTH_KEY=X` (docker runner; the original name is dropped) |
| any var with value `""` set explicitly in `env` | preserved (intentionally empty, e.g. OAuth mode) |
| any other var that resolves to `""` | **deleted** so it can't shadow the image default |
| global `settings.github.token` | `GH_TOKEN`, `GITHUB_TOKEN` |
| global `settings.github.copilot_token` (or GitHub token as fallback), only when `provider: copilot` | `GH_COPILOT_TOKEN`, `GITHUB_COPILOT_TOKEN` |
| `git.token` | overrides `GH_TOKEN`/`GITHUB_TOKEN` |
| `extra.run_as_root` | `HERETIC_RUN_AS_ROOT=1` |
| sidecars configured | `BUILD_SIDECARS={"<rt>":{"internal_url":"http://builder-<rt>:<port>"}}`, `SIDECAR_ENV_PASSTHROUGH=<csv>` |
| `ssh` configured | `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY_PATH`, `SSH_HOST_CWD` |

## Always-added mounts (docker + compose runners)

```
<project>/.heretic/temp/<session>  → /home/agent/.claude   and /root/.claude
                                     (or …/.copilot for agent_type: copilot-cli)
<session>/.claude.json            → /home/agent/.claude.json and /root/.claude.json
                                     (seeded {"hasCompletedOnboarding": true}; non-copilot only)
<session>/entrypoint.sh           → /entrypoint.sh:ro          (only with run_as_root)
<docker socket>                   → /var/run/docker.sock       (only with dind: true)
<ssh.key_path>                    → /home/agent/.ssh/id_rsa:ro (only with ssh.key_path)
```

`claude_settings` is **not** mounted directly: it is merged with
`.heretic/cli/claude-settings.json` and written as `<session>/settings.json`, which the
container sees as `~/.claude/settings.json` through the session-dir mount. If the global
file is missing, a warning is logged and the merge is skipped.

## Minimal working profiles

```yaml
# docker, Claude, workspace mount, key from a script
image: giglabo/claude-heretic:latest
runner: docker
provider: anthropic
agent_type: claude
workdir: /workspace
volumes: [{ source: "${CWD}", target: /workspace }]
env: { ANTHROPIC_API_KEY: "${CLAUDE_API_KEY}" }
secrets: { CLAUDE_API_KEY: ~/.heretic/get-claude-key.sh }
claude_settings: ~/.heretic/claude-settings.json
```

```yaml
# compose, extra database service, node build sidecar
image: giglabo/claude-heretic:latest
runner: compose
workdir: /workspace
volumes: [{ source: "${CWD}", target: /workspace }]
compose:
  services:
    db: { image: postgres:16, environment: { POSTGRES_PASSWORD: dev } }
  volumes: { pgdata: null }
tool_backends:
  sidecars: [{ runtime: node, image: heretic-builder-node:latest }]
```

```yaml
# custom runner — uses .heretic/cli/compose.yaml verbatim
image: unused-but-required:latest
runner: custom
```
