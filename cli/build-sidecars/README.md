# build-sidecars

Server-side pieces for heretic-cli's **build-sidecar** tool-execution backend.

A build sidecar is a per-runtime container (node/python/java/go/rust) that runs
the Go `exec-server` next to a runtime toolchain and shares the agent's
`/workspace` bind. The agent forwards wrapped build commands (`npm install`,
`pytest`, `mvn package`, …) to it over the private compose network, so heavy
toolchains live in the builder instead of the agent image.

## Layout

```
build-sidecars/
  exec-server/
    main.go     # the HTTP exec-server (stdlib only)
    go.mod
  README.md
```

The per-runtime **Dockerfiles are generated**, not vendored, to keep the build
stage single-sourced. Inspect them with:

```bash
heretic-cli image generate --format sidecar-dockerfile --runtime node
```

## Building an image

```bash
heretic-cli image build-sidecar node          # -> heretic-builder-node:latest
heretic-cli image build-sidecar python --runtime-version 3.12 --push -r ghcr.io/acme
```

`main.go`/`go.mod` are embedded into the CLI binary via Bun text imports
(`src/templates/sidecar-images.ts`), so `image build-sidecar` can materialise a
build context and compile the server anywhere — no separate checkout needed.

## Wire contract

The `sidecar-exec` client (baked into the agent image) talks to:

| Method & path | Purpose |
|---------------|---------|
| `GET /health` | liveness; used by the container/compose healthcheck |
| `GET /info` | `{runtime, cwd, version}` — never returns the environment (gap C-10) |
| `POST /exec` | blocking: `{cmd[], cwd, timeout, env{}}` → `{exit_code, output, stderr, error}` |
| `POST /exec/stream` | SSE of `{type: stdout\|stderr\|exit\|error, data}` frames |

`cmd` is an argv array run **without a shell**. `exit_code == -1` signals a
server-side failure (start error / timeout); the client maps a timeout to exit
code 124.

### Hardening (folded in from the reference implementation's defect register)

- **C-9** — optional `EXEC_SERVER_TOKEN` bearer auth, request body size limit,
  read-header timeout; builders publish no ports on the compose network.
- **C-10** — `/info` never returns the process environment.
- **C-11** — stdout and stderr are drained concurrently (no >64 KiB deadlock).
- **C-12** — the child runs as a process-group leader and the **whole group** is
  killed on timeout, so timed-out builds actually die.
- **F-1** — the health probe reads the configured port; nothing hard-codes 8080.
- **F-2** — builders run as a non-root user by default.

## Flags / env

`exec-server` reads `-port`/`-cwd`/`-healthcheck` flags and the
`EXEC_SERVER_PORT`, `EXEC_SERVER_CWD`, `EXEC_SERVER_RUNTIME`, `EXEC_SERVER_TOKEN`
environment variables. `exec-server -healthcheck` probes the local `/health` and
exits 0/1 for use as a container `HEALTHCHECK`.
