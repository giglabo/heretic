# `exec-server` HTTP API (build sidecar server)

Vendored at `cli/build-sidecars/exec-server/{main.go,go.mod}` (module
`github.com/heretic/exec-server`, Go 1.21, stdlib only, `version = "0.1.0"`). Embedded into
the CLI binary as text and materialized into the build context by
`heretic-cli image build-sidecar`. Print it with
`heretic-cli image generate --format exec-server`.

## Invocation

```
exec-server [-port <n>] [-cwd <path>] [-healthcheck]
```

| Flag | Env fallback | Default |
| --- | --- | --- |
| `-port` | `EXEC_SERVER_PORT` | `8080` |
| `-cwd` | `EXEC_SERVER_CWD` | `/workspace` |
| `-healthcheck` | — | off; probes `http://127.0.0.1:<port>/health` (3 s client timeout) and exits 0/1 |

Other env: `EXEC_SERVER_RUNTIME` (reported by `/info`, default `unknown`),
`EXEC_SERVER_TOKEN` (when non-empty, every route except `/health` requires
`Authorization: Bearer <token>`, else 401 `unauthorized`).

Startup line on stderr:
`exec-server 0.1.0: runtime=node cwd=/workspace listening on :8080`.

Server limits: `ReadHeaderTimeout` 10 s; **no** `ReadTimeout`/`WriteTimeout` (long builds hold
the connection); request body capped at **1 MiB** (`maxBodyBytes`) — argv/env/cwd only, never
payload; command timeout default **600 s**, hard cap **3600 s** (`clampTimeout`: `t <= 0` →
600, `t > 3600` → 3600).

## `GET /health` — open, no auth

```json
{ "status": "ok" }
```

## `GET /info` — auth applies

```json
{ "runtime": "node", "cwd": "/workspace", "version": "0.1.0" }
```

Never returns the process environment, regardless of query parameters.

## `POST /exec` — blocking

Request:

```json
{
  "cmd": ["npm", "install", "--save-dev", "vitest"],
  "cwd": "/workspace/packages/api",
  "timeout": 600,
  "env": { "NPM_TOKEN": "…" }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `cmd` | string[] | required, non-empty; `cmd[0]` is the program, no shell involved |
| `cwd` | string | optional; falls back to the server's `-cwd` |
| `timeout` | int (seconds) | optional; clamped to (0, 3600], default 600 |
| `env` | map<string,string> | optional overlay merged over the server's own environment (same key ⇒ overlay wins) |

Response `200`:

```json
{ "exit_code": 0, "output": "…stdout…", "stderr": "…stderr…", "error": "" }
```

`exit_code: -1` plus a non-empty `error` means the command never ran or was killed (spawn
failure, timeout). The client maps a timeout-flavored `error` to exit **124** and any other
`-1` to **255**.

Errors: `405 method not allowed` (non-POST), `400 invalid request body: …`,
`400` when `cmd` is empty, `401 unauthorized` (token set and missing/wrong).

stdout and stderr are captured into separate `*bytes.Buffer`s so Go drains both concurrently
— that is what avoids the classic >64 KiB pipe deadlock on chatty builds.

## `POST /exec/stream` — Server-Sent Events

Same request body. Response is `text/event-stream` with one JSON frame per `data:` line:

```
data: {"type":"stdout","data":"added 42 packages"}
data: {"type":"stderr","data":"npm warn deprecated …"}
data: {"type":"exit","data":0}
data: {"type":"error","data":"command timed out after 600s"}
```

Frame types: `stdout`, `stderr`, `exit` (integer exit code), `error` (fatal message).
A stream that ends **without** an `exit` frame is a transport failure — `sidecar-exec` reports
`stream ended without an exit frame (connection to <url> lost?)` and exits 1.

Enable it from the agent with `SIDECAR_STREAM=1`.

## Process control

Every command gets `SysProcAttr{Setpgid: true}`, so the child is its own process-group
leader. On context cancellation (timeout) the server sends `SIGKILL` to `-pid` — the whole
group — plus a `WaitDelay`, so no orphaned `npm`/`gradle` daemons survive a timeout.

## curl examples

From inside the agent container (builders have no host ports, so this only works on the
shared network):

```bash
curl -s http://builder-node:8080/health
curl -s http://builder-node:8080/info

curl -s -X POST http://builder-node:8080/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd":["node","-v"],"cwd":"/workspace","timeout":30,"env":{}}'

curl -sN -X POST http://builder-node:8080/exec/stream \
  -H 'Content-Type: application/json' \
  -d '{"cmd":["npm","ci"],"cwd":"/workspace","timeout":1800,"env":{}}'

# with EXEC_SERVER_TOKEN set on the builder
curl -s -H "Authorization: Bearer $TOKEN" http://builder-node:8080/info
```

From the host you cannot reach a builder directly by design; use
`docker exec <builder> exec-server -healthcheck` or attach to the network.

## Client/server compatibility notes

- The bundled `sidecar-exec` sends `{cmd, cwd, timeout, env}` and reads only
  `exit_code`, `output`, `stderr`, `error` (blocking) or the four SSE frame types.
- It prints stdout/stderr with `jq -j` so internal newlines survive verbatim (no trailing
  newline is added — a known cosmetic deviation).
- It does **not** send `Authorization`, so `EXEC_SERVER_TOKEN` requires a custom client.
- Both sides default to a 600 s timeout; the client additionally gives curl
  `timeout + 30` seconds so the server's own timeout is what fires first.
