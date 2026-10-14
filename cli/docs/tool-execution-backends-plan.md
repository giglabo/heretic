# Tool Execution Backends in heretic-cli — Integration Plan

> How to make **tool execution backends** — primarily the **HTTP build sidecar** — a
> first-class feature of `heretic-cli`, alongside the SSH backend that is already
> partially wired.
>
> Source of truth for the design: the `tool-execution-backends` spec set
> (`README`, `01-backends`, `02-contracts`, `03-gaps`). This plan maps that design onto
> heretic's actual architecture and folds the known defects (the `03-gaps` register)
> into the implementation from day one.

---

## 0. TL;DR / feasibility verdict

**Highly feasible, and further along than it looks.** heretic already ships the
*agent-side* half of the sidecar/SSH backends:

- `cli/src/templates/assets/entrypoint.sh` contains the exact `setup_tool_wrappers`
  algorithm from the spec — it writes `/opt/sidecar/wrappers/<cmd>` that route to
  `sidecar-exec <runtime>` (when `BUILD_SIDECARS` is set) or `ssh-exec` (when `SSH_HOST`
  is set). This is byte-for-byte the spec's `images-new/entrypoint.sh`.
- `ssh-exec` is a real, working client asset; the `ssh:` profile block is already
  wired through both `docker-runner` and `compose-runner`.
- The `compose-runner` already orchestrates multiple containers and passes through
  `compose.services` / `networks` / `volumes`.

What is **missing / broken** and therefore what this plan delivers:

| Gap (id) | Symptom today | Fix phase |
|---|---|---|
| **A-1** | `Dockerfile.hbs` never `COPY`s the entrypoint and sets **no `ENTRYPOINT`** (only `CMD ["/bin/bash"]`) → `setup_tool_wrappers` never runs → both backends are inert | Phase 0 |
| **A-3** | `/opt/sidecar/wrappers` is created root-owned; the agent runs as uid 1000 → entrypoint would die under `set -e` the moment a backend is configured | Phase 0 |
| **C-21** | Baked `/opt/sidecar/sidecar-exec` is a **stub that always exits 1** | Phase 0/1 |
| run_as_root path | override binds entrypoint over `/opt/heretic/entrypoint.sh`, which the image never execs | Phase 0 |
| no exec-server | heretic has no Go `exec-server` and no builder images | Phase 1 |
| no orchestration | nothing spawns builders, creates the shared workspace, injects `BUILD_SIDECARS`, or health-gates | Phase 2–3 |

So the critical path is: **(0) make the agent-side actually run → (1) provide the
server-side pieces → (2–3) orchestrate them from a profile.** Phase 0 by itself makes
the *SSH* backend fully functional end-to-end.

---

## 1. Background: the two shipped backends we are targeting

From `01-backends.md` / `02-contracts.md`, verified against heretic's own code:

### Sidecar backend (the "watchword: sidecar")
A long-lived sibling container per runtime, sharing the workspace, exposing a tiny HTTP
exec API:

```
agent container                              builder-node container
 PATH=/opt/sidecar/wrappers  ──POST /exec──►  exec-server (Go static bin)
  npm → sidecar-exec node …  ◄──JSON────────  node/npm/pnpm/yarn on PATH
        │        both mount the SAME /workspace         │
        └────────────────────► /workspace ◄────────────┘
```

- **Contract** (`02-contracts §1`): agent env
  `BUILD_SIDECARS={"node":{"internal_url":"http://builder-node:8080"}}`. Runtime key
  MUST be one of `node|python|java|go|rust`; clients read **only** `internal_url`.
- **exec-server API** (`02-contracts §2`): `GET /health`, `GET /info`,
  `POST /exec` (blocking JSON), `POST /exec/stream` (SSE). `cmd` is an argv array, no
  shell.
- **Wrapper generation** (`02-contracts §3`): local binary always wins, decided
  per-command; wrappers regenerated every container start.

### SSH backend
`ssh-exec <cmd>` runs `ssh user@host "cd $CWD && cmd"` per command. Already present in
heretic. Its defining limitation is that it builds a **different filesystem** than the
agent edits (`01-backends §4`) unless you use the same-path-bind trick to the Docker
host (`§5`).

---

## 2. Design decisions (heretic-specific)

The spec's production topology is an out-of-process orchestrator (`SidecarManager`)
driving a named workspace volume. heretic is a local-dev CLI where the workspace is the
**user's project directory, bind-mounted**. That changes three decisions for the better:

1. **Share the workspace by bind, not by named volume.** Builders mount the *same host
   path* at `/workspace` that the agent does. This makes the "same filesystem"
   invariant hold for free and sidesteps the named-volume host-path divergence
   (`README §1`, shape B caveats in `01-backends §5`).

2. **Run builders as the caller's uid by default.** The spec's #1 operational failure is
   root-owned build artefacts (`F-2`, scenario matrix "Files written are agent-owned:
   ❌"). Because our shared tree *is the user's own project*, root-owned `node_modules/`
   would be actively harmful. Default builder services to
   `user: "${HERETIC_UID}:${HERETIC_GID}"` with a writable cache `HOME`.

3. **The `compose-runner` is the orchestration home for the MVP.** It already models
   multi-container + networks + volumes, and `docker compose up` gives us
   `depends_on: {condition: service_healthy}` (health-gating) and teardown for free —
   exactly what `SidecarManager.wait_healthy()` / `cleanup()` do by hand. A
   dockerode-native path for the single-container `docker` runner is Phase 4 (parity).

---

## 3. Phases

### Phase 0 — Make the agent-side actually run (prerequisite; unblocks SSH immediately)

Files: `cli/src/templates/assets/Dockerfile.hbs`, `.../entrypoint.sh`,
`cli/src/runners/docker-runner.ts`, `compose-runner.ts`, `cli/src/templates/resources.ts`.

1. **Bake the entrypoint (A-1).** In `Dockerfile.hbs`, before `CMD`:
   ```dockerfile
   COPY entrypoint.sh /entrypoint.sh
   RUN chmod +x /entrypoint.sh
   ENTRYPOINT ["/entrypoint.sh"]
   CMD ["/bin/bash"]
   ```
   Place the `COPY` before `USER ${AGENT_USER}` (or `chown` it). `image build` already
   writes `entrypoint.sh` into the build context (`image.ts:prepareBuildDir`), so this is
   a template-only change. The entrypoint already `exec "$@"`s, satisfying the
   orchestrator↔agent contract (`02-contracts §7`).

2. **Make the wrapper dir writable (A-3).** In the same layer that creates
   `/opt/sidecar/wrappers`, add
   `&& chown ${AGENT_UID}:${AGENT_GID} /opt/sidecar/wrappers` (or `chmod 1777`). Add a
   writability probe to `setup_tool_wrappers` that fails with a clear message instead of a
   bare `Permission denied` under `set -e`.

3. **Replace the `sidecar-exec` stub with a real, corrected client (C-21).** Author a
   bash `sidecar-exec` (curl + jq) implementing the `02-contracts §4` contract, with the
   gap fixes baked in:
   - stream exit-code propagation via process substitution / `lastpipe` (**C-3** — the
     single most dangerous defect: streaming currently always exits 0);
   - default `SIDECAR_TIMEOUT` aligned to the server (**C-5**, use 600+);
   - map server `exit_code:-1 + "timed out"` → 124, print `error` to stderr first
     (**C-6**);
   - optional `SIDECAR_ENV_PASSTHROUGH` allowlist to populate request `env` (**C-8**).

   Embed it as a text asset in `resources.ts` (replacing `SIDECAR_EXEC_STUB`) so
   `bun build --compile` includes it and `image build` bakes the real client.

4. **Fix the `run_as_root` override target.** Both runners bind the embedded entrypoint
   over `/opt/heretic/entrypoint.sh`; once we bake `ENTRYPOINT ["/entrypoint.sh"]` the
   override bind must target `/entrypoint.sh`. Update the runners and the CLAUDE.md note
   (which currently references the non-existent `/opt/heretic/entrypoint.sh`).

5. **Smoke test (the cheapest regression guard, per `02-contracts §9`):**
   `docker run -e BUILD_SIDECARS='{"node":{"internal_url":"http://x:8080"}}' <img>
   bash -c 'ls /opt/sidecar/wrappers | wc -l'` → must be > 0. Assert the generated
   Dockerfile contains `ENTRYPOINT`.

**Outcome:** wrappers generate; the **SSH backend works end-to-end** (config already
wired); the sidecar client is real and waiting for a server.

---

### Phase 1 — Provide the server-side pieces (exec-server + builder images)

> **DONE (2026-08-07).** Vendored `build-sidecars/exec-server/{main.go,go.mod}` — a
> stdlib-only Go `exec-server` implementing `/health`, `/info`, `/exec` (blocking),
> and `/exec/stream` (SSE), with the server-side gaps folded in: concurrent
> stdout/stderr drain (C-11), `Setpgid` + process-group kill on timeout (C-12),
> optional `EXEC_SERVER_TOKEN` bearer auth + body limit + read-header timeout (C-9),
> and `/info` that never leaks env (C-10). The source is embedded via Bun text
> imports (`src/templates/sidecar-images.ts`) and compiled inside each builder's
> Docker build stage. `generateSidecarDockerfile()` emits a hardened multi-stage
> builder per runtime (non-root user F-2, port-agnostic healthcheck F-1).
> `heretic-cli image build-sidecar <runtime>` builds `heretic-builder-<runtime>:latest`
> (`--runtime-version`/`--go-builder`/`--port`/`--registry`/`--push`/`--arch`/`--dry-run`),
> and `image generate` gained `--format sidecar-dockerfile` and `--format exec-server`.
> Verified end-to-end against the real `sidecar-exec` client (blocking + streaming
> exit codes, env passthrough, timeout→124, process-group kill). **Also fixed a
> showstopper in the Phase 0 `sidecar-exec` client:** it built argv with jq's
> `$ARGS.positional --args`, which jq 1.6 (Debian bookworm — the builder base) does
> NOT treat as positional, so any dash-flag (`npm install --save-dev`, `go build -o`)
> died with "Unknown option". Rewritten to encode argv incrementally with `--arg`.

heretic builds its own images, so it should build its own builders too. Vendor a
`build-sidecars/` tree into the repo and teach `image` to build it.

1. **`build-sidecars/exec-server/main.go`** — the Go static exec-server. Reimplement the
   `02-contracts §2` API, folding in the server-side gaps:
   - drain stdout/stderr concurrently to avoid the **>64 KiB stderr deadlock (C-11)**;
   - set `Setpgid` and kill the process group on timeout so timed-out processes actually
     die (**C-12**);
   - honour `env` from the request (already in the wire type) and add `ReadTimeout`,
     a `MaxBytesReader` body limit, and — for anything beyond a single-host private
     compose network — an optional `Authorization: Bearer` check (**C-9**);
   - drop `/info?env=true` to an allowlist or remove it (**C-10**).

2. **`build-sidecars/<runtime>/Dockerfile`** for `node|python|java|go|rust` — runtime
   base + `COPY --from` the exec-server + `WORKDIR /workspace` + a **non-root `USER`**
   (**F-2**) + a `HEALTHCHECK` that does **not** hard-code the port (**F-1**) +
   `CMD ["exec-server","-port","8080","-cwd","/workspace"]`.

3. **`heretic-cli image build-sidecar <runtime>`** (new subcommand, mirrors
   `image build`): builds `heretic-builder-<runtime>:latest`, `--registry`/`--push`
   support, version knobs (`--node-version` etc.). Reuse `image.ts` plumbing.

**Fast on-ramp alternative:** if writing the Go server is deferred, Phase 3 can point
`image:` at pre-built `builder-*` images from a registry; only Phase 0's real
`sidecar-exec` client is strictly required on the agent side. Document this as the
"bring-your-own-builder" mode.

---

### Phase 2 — Profile schema + config resolution

> **DONE (2026-08-07).** `SidecarRuntime`/`BuildSidecar`/`ToolBackends` added to
> `agent-profile.ts`; `tool_backends` merges in `config-resolver` (sidecars array
> replaces, scalars replace) and resolves to `ResolvedAgentConfig.toolBackends`;
> `validateResolvedConfig` rejects unknown runtimes (B-3), empty images, duplicate
> runtimes, out-of-range ports, and a missing workspace volume, and warns on the
> sidecar+SSH overlap (B-5); `run` gained `--sidecar` / `--builder-image` /
> `--disable-sidecars` and auto-selects the compose runner (rejects `custom`).

Files: `cli/src/types/agent-profile.ts`, `cli/src/utils/config-resolver.ts`,
`cli/src/commands/run-agent.ts`, `cli/src/cli.ts`.

1. **Types.** Add a `tool_backends` block to `AgentProfile` (and mirror into
   `ResolvedAgentConfig`). Keep the existing `ssh:` block as the SSH backend (backward
   compatible); both resolve into the same wrapper mechanism.
   ```ts
   export type SidecarRuntime = "node" | "python" | "java" | "go" | "rust";

   export interface BuildSidecar {
     runtime: SidecarRuntime;      // MUST be one of the five (02-contracts §1)
     image: string;               // e.g. heretic-builder-node:latest
     port?: number;               // default 8080
     env?: Record<string, string>;        // injected into the builder
     env_passthrough?: string[];          // allowlist forwarded per-exec (C-8)
     cache_volumes?: string[];            // named vols for ~/.npm, GOMODCACHE, … (F-3)
   }

   export interface ToolBackends {
     sidecars?: BuildSidecar[];
     workspace_target?: string;   // default "/workspace" (the shared bind)
     ready_timeout?: number;      // seconds, default 60 (sidecar-ready-timeout)
     run_as_caller_uid?: boolean; // default true (F-2)
   }
   ```

2. **Merge rules** in `config-resolver.mergeConfigs`: `tool_backends.sidecars` replaces
   as an array; scalars replace; `env` shallow-merges — consistent with existing rules.
   Interpolate `${VAR}` in images/env as today.

3. **Validation** (`validateResolvedConfig`), turning silent spec failure modes into
   loud ones:
   - `runtime` ∈ the five names — reject others (**B-3**: unknown keys silently route
     nothing);
   - warn when a runtime has **both** a sidecar and SSH is enabled — one build would span
     two filesystems (**B-5**);
   - warn when `.mcp.json`/workspace has an existing `.mcp.json` … (already handled);
   - note that only 25 commands are routable — `make`, `tsc`, `jest`,
     `./node_modules/.bin/*`, `uv`, `bun` are **not** (**B-2**); surface this in docs.

4. **CLI flags** on `run`: `--sidecar <runtime>` (repeatable, one-off), `--no-sidecar`,
   `--builder-image <runtime>=<image>`. When any sidecar is active, auto-select the
   `compose` runner unless the profile pins `runner: docker` (then error with a hint, or
   fall through to Phase 4).

---

### Phase 3 — Compose-runner orchestration (the core of the feature)

> **DONE (2026-08-07).** `ComposeRunner.buildSidecarOrchestration()` emits one
> `builder-<runtime>` service per sidecar bound to the same host workspace path,
> injects `BUILD_SIDECARS` (normative shape) + a unioned `SIDECAR_ENV_PASSTHROUGH`
> into the agent, gates the agent on each builder via `depends_on … service_healthy`,
> runs builders as the caller uid with `cap_drop:[ALL]` + `no-new-privileges` and
> no published ports, mounts named `cache_volumes` and declares them at the top
> level (also fixes the pre-existing gap where `compose.volumes` was never emitted).
> Uses the fast on-ramp: any builder image running an `exec-server` works — the Go
> server + `image build-sidecar` (Phase 1 full) is still pending.

File: `cli/src/runners/compose-runner.ts` (extend `generateComposeYaml`).

When `config.toolBackends?.sidecars` is non-empty, emit builder services alongside the
`agent` service:

1. **Resolve the workspace bind.** Find the agent volume whose `target ===
   workspace_target` (default `/workspace`). Every builder gets the *same* bind, so all
   containers see one filesystem (`README §1` invariant).

2. **Per builder service** `builder-<runtime>`:
   ```yaml
   builder-node:
     image: heretic-builder-node:latest
     command: ["exec-server", "-port", "8080", "-cwd", "/workspace"]
     working_dir: /workspace
     user: "1000:1000"            # caller uid when run_as_caller_uid (F-2)
     environment: { NX_DAEMON: "false", HOME: /workspace/.cache/heretic-node }
     volumes:
       - /abs/host/project:/workspace          # SAME bind as agent
       - heretic-cache-node:/workspace/.cache/heretic-node   # warm caches (F-3)
     healthcheck:
       test: ["CMD","exec-server","-healthcheck"]   # or wget the right port (F-1)
       interval: 2s
       timeout: 3s
       retries: 15                # ~ ready_timeout
   ```

3. **Wire the agent service:**
   - inject `BUILD_SIDECARS` in the exact normative shape
     `{"node":{"internal_url":"http://builder-node:8080"}}` (`02-contracts §1`) —
     builders are reachable by compose service name on the project network;
   - `depends_on: { builder-node: { condition: service_healthy } }` so the agent starts
     only after `/health` passes — this replaces the orchestrator's manual
     `wait_healthy()` polling loop;
   - ensure the agent and builders share the compose project network (default network is
     fine — service names resolve).

4. **Teardown.** `docker compose down` (already in `stop()`) removes builders + network;
   keep named cache volumes unless `--cleanup-volumes`.

5. **Security posture for the local case.** Do not publish builder ports; the compose
   network is private. Add `cap_drop: [ALL]` + `security_opt: [no-new-privileges:true]`
   to builders. A per-run bearer token (`C-9`) is optional for local dev but should be a
   documented switch for shared hosts.

**Illustrative end result** — profile in, compose out:

```yaml
# ~/.heretic/agents/claude-node.yaml
image: heretic-agent:latest
runner: compose
volumes:
  - { source: "${CWD}", target: /workspace }
workdir: /workspace
tool_backends:
  run_as_caller_uid: true
  ready_timeout: 60
  sidecars:
    - { runtime: node,   image: heretic-builder-node:latest }
    - { runtime: python, image: heretic-builder-python:latest }
```
→ generates an `agent` service with
`BUILD_SIDECARS={"node":{"internal_url":"http://builder-node:8080"},"python":{"internal_url":"http://builder-python:8080"}}`,
two healthy-gated builder services sharing `${CWD}:/workspace`, and inside the agent
`npm`, `pip`, `pytest`, … resolve to wrappers that POST to the right builder.

---

### Phase 4 — dockerode-native sidecar manager (optional, for `runner: docker`)

> **DONE (2026-08-07).** `runners/sidecar-manager.ts` — `SidecarManager` reproduces
> the compose orchestration with the dockerode API: a per-run user-defined network
> (`heretic-net-<agent>-<session>-<hash>`), one builder container per runtime sharing
> the same workspace bind with a `builder-<runtime>` network alias, health polling
> (container HEALTHCHECK, else an `exec-server -healthcheck` exec probe) standing in
> for compose's `condition: service_healthy`, and label-based teardown. `DockerRunner`
> starts sidecars before the agent, injects `BUILD_SIDECARS` + `SIDECAR_ENV_PASSTHROUGH`,
> joins the agent to the network, and tears sidecars down in `stop()` / on start
> failure. `run-agent` no longer force-switches to compose (only `custom` is rejected).
> `heretic-cli stop` removes sidecar siblings + the per-run network by label (handles
> the detached case); `heretic-cli ps` hides sidecars from the agent listing. Named
> `cache_volumes` are preserved across runs (persistent-cache follow-up, gap F-3).
> Same BUILD_SIDECARS shape / hardened posture / caller-uid default as the compose path.

For parity with the single-container path (detached mode, `attach`, `ps`, `stop`),
port `SidecarManager` to TypeScript in a `SidecarManager` helper used by
`docker-runner.ts`: create a per-run network + (bind) workspace, `docker run` each
builder, poll `GET /health` every 2s up to `ready_timeout`, then create the agent with
`BUILD_SIDECARS`, and tear all of it down in `stop()`. This mirrors
`sidecar_manager.py:652-836` / `910-975`. Label everything `heretic.*` for `ps`/cleanup.

---

### Phase 5 — Docs + tests (required by CLAUDE.md)

- **`cli/docs/USER_GUIDE.md`**: new "Tool execution backends" section — sidecar vs SSH,
  the profile schema, `image build-sidecar`, the `--sidecar` flag, the 25-command
  routing caveat (`B-2`), and the "local binary always wins" rule.
- **`cli/AGENTS.md`**: how an agent working on the repo configures/validates sidecars.
- **Tests** (`bun:test`): compose generation with sidecars (asserts `BUILD_SIDECARS`
  shape, shared bind, `depends_on.service_healthy`, `user` uid); config-resolver
  validation (reject bad runtime, warn on sidecar+SSH overlap); Dockerfile contains
  `ENTRYPOINT`; the wrapper smoke test from Phase 0.
- **Rebuild the binary** (`cd cli && bun run build`) and run `bun run format` +
  `bun run lint` — both must pass (CLAUDE.md).

---

## 4. Known-pitfalls checklist (folded in from `03-gaps.md`)

Each row is a defect the reference implementation shipped; the plan avoids it by
construction:

| Gap | Avoided by |
|---|---|
| A-1 no ENTRYPOINT | Phase 0.1 bakes it + smoke test |
| A-3 wrapper dir unwritable | Phase 0.2 chown + probe |
| C-3 stream always exits 0 | Phase 0.3 corrected client (process substitution) |
| C-5 300s default | Phase 0.3 align default to server |
| C-8 no env/secret forwarding | `env_passthrough` allowlist |
| C-9 unauthenticated root RCE | private compose net + `cap_drop`/`no-new-privileges` + optional bearer token |
| C-10 `/info?env=true` leak | drop/allowlist in Phase 1 server |
| C-11 stderr deadlock | concurrent drain in Phase 1 server |
| C-12 timeout doesn't kill | `Setpgid` + group kill |
| B-2 only 25 commands routable | documented; `make`/`tsc`/`.bin/*` run locally |
| B-3 unknown runtime silent | Phase 2 validation rejects non-five runtimes |
| B-5 sidecar+SSH split tree | Phase 2 warning |
| F-1 healthcheck hard-codes :8080 | compose healthcheck uses the real port |
| F-2 root-owned artefacts | `run_as_caller_uid: true` default |
| F-3 cold caches | optional per-runtime `cache_volumes` |

## 5. Interactivity ceiling (set expectations)

The HTTP sidecar cannot do stdin, TTY, REPLs, watch modes, or Ctrl-C
(`scenario matrix`, `C-1/C-2/C-17`). Route only non-interactive, CI-shaped commands
(install / build / test / lint / format) through it; keep interactive tools local, or
use the SSH-to-Docker-host backend (`01-backends §5`) for host toolchains. The
host-agent daemon / Unix-socket designs (`01-backends §6–7`) remain the future path for
true interactivity and are out of scope here.

## 6. Suggested order of work

1. Phase 0 (unblocks SSH, makes the client real) — small, high value, testable alone.
2. Phase 1 fast on-ramp (bring-your-own builder image) → validate the whole loop with a
   registry `builder-node` before writing the Go server.
3. Phase 2 + 3 (schema + compose orchestration) — the actual feature.
4. Phase 1 full (vendor exec-server + `image build-sidecar`).
5. Phase 4 (dockerode parity) + Phase 5 (docs/tests) throughout.
