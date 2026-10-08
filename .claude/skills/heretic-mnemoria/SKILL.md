---
name: heretic-mnemoria
description: Complete reference for the `heretic-cli mnemoria` (alias `mn`) command group foundations — global flags, config file and named profiles, the full config-key list with env-var overrides, OIDC authentication (PKCE, forwarded PKCE, device flow, token scripts), token refresh and storage, `status` and `config diagnose`, output modes (table/json/plain), color/ID/timestamp formatting, pagination, the HTTP client's retry and error mapping, and exit codes. Use for any mnemoria setup/auth/connection/output/exit-code question, or as the entry point before the palace, memory, and graph mnemoria skills.
---

> **Branch-only feature.** The whole `mnemoria` group was added in the `feat/mnemoria` branch
> (commit `441cea2 "Add Mnemoria memory server client"`, `cli/src/commands/mnemoria/`) and is
> **not merged into `main`** — `main`'s `cli.ts` contains no mnemoria registration at all.
> `git branch --contains 441cea2` lists only `feat/mnemoria`. Treat these four
> `heretic-mnemoria*` skills as an archive of that branch: if the branch is dropped or
> rebased, the commands documented here disappear from the CLI. Archived copies are stored in
> watchword (see `heretic-cli-skills` / `mnemoria-docs`).

# `heretic-cli mnemoria` — memory server client (foundations)

```
heretic-cli mnemoria [global options] <subcommand> …
heretic-cli mn       [global options] <subcommand> …     # alias
```

Mnemoria is an external HTTP memory server ("memory palace" model). This client is a typed
wrapper over `fetch` — **all** business logic lives server-side. Sources:
`cli/src/commands/mnemoria/*` (`index, context, client, config-loader, auth, output,
pagination, errors, types` + one file per command group).

Companion skills: `heretic-mnemoria-spaces` (palace/wing/room),
`heretic-mnemoria-memory` (store/get/list/delete/search/keyword/file/ingest),
`heretic-mnemoria-graph` (entity/triple/graph).

## Global options (declared on the group, inherited by every subcommand)

| Flag | Meaning |
| --- | --- |
| `-s, --server <url>` | override server URL for this invocation |
| `-p, --profile <name>` | use `~/.heretic/mnemoria/profiles/<name>.yaml` |
| `-P, --palace <id\|name>` | override the default palace |
| `-j, --json` | JSON output (suppresses human lines) |
| `--plain` | tab-separated rows, no headers |
| `--no-color` | disable ANSI color |
| `--ids <short\|full>` | UUID display mode |

They are read through Commander's `optsWithGlobals()`, so they work **before or after** the
subcommand: `mn -j palace list` and `mn palace list -j` are both fine.

## Configuration

Files (all under `~/.heretic/mnemoria/`, dir created on demand):

```
config.yaml            main config
auth.yaml              OIDC tokens (chmod 0600)
auth-local.yaml        writable overlay used when auth.yaml is read-only (containers)
profiles/<name>.yaml   named connection profiles (same schema as config.yaml)
```

Precedence: **CLI flags > env vars > named profile > config.yaml > built-in defaults.**

Complete key list, defaults, and env overrides:

| Key | Type / allowed | Default | Env override |
| --- | --- | --- | --- |
| `server.url` | string | `http://localhost:3000` | `MN_SERVER_URL` |
| `server.timeout` | number (ms) | `30000` | `MN_SERVER_TIMEOUT` |
| `server.retry.attempts` | number | `3` | — |
| `server.retry.delay` | number (ms) | `1000` | — |
| `auth.mode` | `oidc` \| `token_script` \| `disabled` | `oidc` | `MN_AUTH_MODE` |
| `auth.provider` | `keycloak` \| `auth0` | `keycloak` | — |
| `auth.issuer` | string | `""` | `MN_AUTH_ISSUER` |
| `auth.client_id` | string | `mnemoria-cli` | `MN_AUTH_CLIENT_ID` |
| `auth.token_script` | path | `""` | — |
| `defaults.palace` | id or name | `""` | `MN_DEFAULT_PALACE` |
| `defaults.language` | code | `en` | `MN_DEFAULT_LANGUAGE` |
| `defaults.output` | `table` \| `json` \| `plain` | `table` | `MN_OUTPUT` |
| `defaults.page_size` | number | `20` | — |
| `defaults.wing` | name | `""` | `MN_DEFAULT_WING` |
| `defaults.room` | name | `""` | `MN_DEFAULT_ROOM` |
| `output.color` | `auto` \| `always` \| `never` | `auto` | — |
| `output.timestamps` | `relative` \| `absolute` | `relative` | — |
| `output.ids` | `short` \| `full` | `short` | — |

Other env vars: `MN_ACCESS_TOKEN` (highest-priority bearer token),
`MN_CONTAINER=1` (force "inside container" detection),
`MN_AUTH_CALLBACK_PORT` (enables forwarded-PKCE login), plus `NO_COLOR` (standard).

### `config` subcommands

```
mn config show                     # effective config + file paths
mn config set <key> <value>        # dot-notation write into config.yaml
mn config login [--device-flow] [--provider …] [--issuer …] [--client-id …]
mn config logout                   # delete auth.yaml and auth-local.yaml
mn config profiles                 # list "default" + profiles/*.yaml with server + auth mode
mn config use-palace <id-or-name>   # resolve, then persist defaults.palace (by NAME)
mn config diagnose                 # environment detection for the auth flow
```

`config show` (table mode):

```
Server:     http://localhost:3000
Auth mode:  oidc (keycloak)
Profile:    default

DEFAULT    VALUE
Palace     (none)
Language   en
Output     table
Page size  20
Wing       (none)
Room       (none)

Config file: /home/you/.heretic/mnemoria/config.yaml
Auth file:   /home/you/.heretic/mnemoria/auth.yaml
```

`config set` validates the key against a fixed allowlist and **suggests the nearest match**
(Levenshtein ≤ 3): `Unknown config key 'server.rul'` + `Did you mean 'server.url'?`.
Numeric keys (`server.timeout`, `server.retry.attempts`, `server.retry.delay`,
`defaults.page_size`) must parse as numbers; every enum key is checked with an explicit
`Allowed: …` hint. `config set` only ever writes `config.yaml` — profiles must be edited by
hand.

`config diagnose` (JSON shown):

```json
{ "in_container": true, "can_open_browser": false,
  "selected_method": "device_flow", "auth_callback_port": null, "display": null }
```

## Authentication

Token resolution order on **every request** (`createTokenProvider`):

1. `MN_ACCESS_TOKEN` env var → used verbatim.
2. `auth.mode: disabled` → no token (request goes out unauthenticated).
3. `auth.mode: token_script` + `auth.token_script` → execute the script (30 s timeout, `~`
   expanded; `.ps1` via powershell, `.cmd`/`.bat` via cmd.exe, otherwise `/bin/bash`),
   stdout trimmed. Empty output → `Token script '<p>' produced empty output`.
4. Stored `auth.yaml` (or `auth-local.yaml`): if the access token is expired (30 s skew
   buffer) and a valid `refresh_token` exists → refresh, persist, use; otherwise
   `Stored access token is expired. Run 'heretic-cli mnemoria config login'.`

### `config login` — flow selection

`selectAuthMethod()`:

| Situation | Method |
| --- | --- |
| not in a container, browser available (macOS/Windows, or Linux with `DISPLAY`/`WAYLAND_DISPLAY`) | `pkce` |
| not in a container, no browser | `device_flow` |
| in a container (`/.dockerenv` or `MN_CONTAINER=1`) with `MN_AUTH_CALLBACK_PORT` | `pkce_forwarded` |
| in a container without it | `device_flow` |

`--device-flow` forces the device grant. Missing issuer →
`No OIDC issuer configured` + `Run: heretic-cli mnemoria config set auth.issuer <url>`.

**PKCE**: 32-byte verifier, S256 challenge, random 16-byte `state`; a local HTTP server binds
`127.0.0.1:0` (random port) and serves `/callback`, verifying `state` and rendering a small
HTML page; the browser is opened with `open` / `start` / `xdg-open`. Then
`authorization_code` + `code_verifier` → tokens. `pkce_forwarded` binds `0.0.0.0` on
`MN_AUTH_CALLBACK_PORT` so a host-forwarded port can deliver the callback into a container.

**Device flow** (RFC 8628): prints `Visit: <uri>` / `Code: <user_code>` (and
`verification_uri_complete` when offered), then polls the token endpoint honoring
`authorization_pending`, `slow_down` (+5 s), `access_denied`, `expired_token`.

Endpoint URLs are derived from the issuer:

| Provider | authorize | token | device |
| --- | --- | --- | --- |
| keycloak | `<issuer>/protocol/openid-connect/auth` | `…/token` | `…/auth/device` |
| auth0 | `<issuer>/authorize` | `<issuer>/oauth/token` | `<issuer>/oauth/device/code` |

Default scope: `openid profile email offline_access`.

Stored `auth.yaml` fields: `provider, issuer, client_id, login_method, access_token,
refresh_token, token_expiry, refresh_expiry, user_email, user_id, tenant_id, tenant_name,
roles`. Identity fields come from decoding the `id_token` payload (`email`, `sub`,
`tenant_id`/`org_id`, `tenant_name`/`org_name`, `roles`) — the token is **not** verified,
it is only read for display. `saveAuthFile()` writes `auth.yaml` at 0600 and falls back to
`auth-local.yaml` when that path is not writable (read-only mount inside a container);
`loadAuthFile()` prefers the overlay.

## `mn status`

Composite health/auth/defaults check. Table form:

```
Server:    http://localhost:3000  ✓ reachable
Version:   1.4.2
Auth:      keycloak (valid, expires in 42m)
User:      you@example.com
Tenant:    Acme (acme-tenant-id)
Palaces:   3

DEFAULT   VALUE
Palace    engineering
Wing      (none)
Room      (none)
Language  en
Output    table
```

Behavior: `GET /health/ready` (unauthenticated); auth state from `auth.mode`,
`MN_ACCESS_TOKEN`, or the stored token's expiry; when both server and auth are OK it lists up
to 100 palaces to report a count and resolve the default palace's ID.
`--json` emits `{server:{url,reachable,version,error}, auth:{…}, palaces, defaults:{…}}`.

Then it **throws**: unreachable → `Server is not reachable` (exit **3**), not authenticated →
`Not authenticated` (exit **2**). Verified example (no server running):

```
Server:    http://localhost:3000  ✗ Cannot connect to Mnemoria server at http://localhost:3000/health/ready
Auth:      not authenticated
…
Error: Server is not reachable
Hint: Check MN_SERVER_URL and that the Mnemoria server is running.
$ echo $?   → 3
```

## Output modes

`resolveOutput()`: `--json` → json; `--plain` → plain; else `defaults.output` when it is
`json`/`plain`; else **`table` if stdout is a TTY, `plain` otherwise**. So piping into
`jq`/`cut`/`awk` automatically gives tab-separated rows — no flag needed.

Color: off if `NO_COLOR` is set, off with `--no-color`, off with `output.color: never`, on
with `always`, otherwise TTY-dependent. Table padding measures **visible** width (ANSI codes
stripped), so colored cells still align.

IDs: `short` prints the first 8 chars, `full` prints the whole UUID (`--ids full`).
Timestamps: `relative` (`5m ago`, `3d ago`, `in 2h`) or `absolute` (raw ISO).
`emitLine()` is a no-op in JSON mode, which is why `-j` output stays machine-clean.

## Pagination

List commands share `--limit <n>` (default `defaults.page_size`), `--after <cursor>`, and
`--all`.

- Single page + `--json` → an **envelope**:
  `{items, total, has_next, has_previous, next_cursor, previous_cursor}`.
- `--all` + `--json` → a **flat array** (`collectAllPages` threads cursors, stops on
  `has_next: false`, a missing cursor, a repeated cursor, or a hard limit of **10 000** items;
  palace-name resolution uses 5 000).
- Table mode for `palace list` also prints `(more results: --after <cursor>)` when there is a
  next page.

## HTTP client, retry, and error mapping

`MnemoniaClient.request()` retries up to `retry.attempts + 1` times with **exponential
backoff** (`delay * 2^(attempt-2)`) on 5xx and network `TypeError`s only; the per-request
deadline is `AbortSignal.timeout(server.timeout)`. `Authorization: Bearer …` is added when a
token resolves; `204`/empty bodies return `undefined`.

| HTTP | Error class | Exit | Message shape |
| --- | --- | --- | --- |
| 400/422 | `MnemoniaValidationError` | 1 | server detail (+ field list) |
| 401 | `MnemoniaAuthError` | **2** | `Authentication failed: …` + login hint |
| 403 | `MnemoniaForbiddenError` | 1 | `Permission denied: …` + role hint |
| 404 | `MnemoniaNotFoundError` | 1 | `<Resource> "<id>" not found` + `… <kind> list` hint |
| 409 | `MnemoniaConflictError` | 1 | server detail |
| 429 | `MnemoniaRateLimitError` | 1 | includes `retry-after` seconds when present |
| 5xx / other | `MnemoniaServerError` | 1 | `Mnemoria server error <n>: …` |
| network | `MnemoniaConnectionError` | **3** | `Cannot connect to Mnemoria server at <url>` |
| timeout | `MnemoniaTimeoutError` | **3** | `Request to <url> timed out after <ms>ms` + timeout hint |

Error detail is extracted from `error.message`, `message`, or `detail` in the body (else the
first 500 chars of text). Client-side errors: `MnemoniaPalaceRequiredError` (no palace),
`MnemoniaAmbiguousError` (name matches several), `MnemoniaConfigError` (bad key/profile).

In `--json` mode errors are rendered as `{"error":{"message":…,"suggestion":…}}`; otherwise
`Error: …` + `Hint: …`.

Exit codes: `0` success, `1` general, `2` auth, `3` connection/timeout, `130` user
cancellation at a confirm prompt.

## Setup recipe

```bash
heretic-cli mn config set server.url https://mnemoria.internal
heretic-cli mn config set auth.issuer https://keycloak.internal/realms/acme
heretic-cli mn config set auth.client_id mnemoria-cli
heretic-cli mn config login                 # or: --device-flow
heretic-cli mn status
heretic-cli mn palace create --name engineering --language en --set-default
heretic-cli mn config use-palace engineering
```

CI / headless / container:

```bash
export MN_SERVER_URL=https://mnemoria.internal
export MN_ACCESS_TOKEN="$(vault read -field=token secret/mnemoria)"
export MN_DEFAULT_PALACE=engineering
heretic-cli mn -j list --all | jq '.[].id'
```

or a token script:

```bash
heretic-cli mn config set auth.mode token_script
heretic-cli mn config set auth.token_script ~/.heretic/get-mnemoria-token.sh
```

## Gotchas

- `defaults.palace` may hold a **name or a UUID**; a name costs one extra list call per
  command (resolution is case-insensitive, exact match first, then unique prefix).
  `config use-palace` stores the **name**.
- `mn status` exits non-zero by design — don't use it as a boolean without handling 2/3.
- `--plain` prints **no header row**; column order matches the table.
- `-j` and `--plain` together: `-j` wins.
- Retries only cover 5xx and network errors; a 4xx is final.
- `config set` cannot unset a key — edit `config.yaml` to remove it.
- Profiles are read-only from the CLI's point of view (`-p <name>` selects one; nothing
  writes them).
- The client sends the token on every request through the provider callback, so a refresh
  can happen mid-session transparently.
