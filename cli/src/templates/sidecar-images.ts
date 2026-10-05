/**
 * Builder-image generation for tool-execution build sidecars.
 *
 * A "builder" image runs the vendored Go `exec-server` (build-sidecars/exec-server)
 * next to a runtime toolchain (node/python/java/go/rust). The agent forwards
 * wrapped build commands to it over the private compose network. This module is
 * the server-side counterpart to the agent-side `sidecar-exec` client baked by
 * `image build`.
 *
 * The Go source is embedded via Bun text imports (single source of truth on
 * disk at build-sidecars/exec-server/) so `bun build --compile` bakes it into
 * the binary and `image build-sidecar` can materialise a build context anywhere.
 *
 * Pure functions — no I/O. `image.ts` writes the returned strings into a temp
 * build dir and shells out to `docker build`.
 */

import type { SidecarRuntime } from "../types/agent-profile";
import { SIDECAR_RUNTIMES } from "../types/agent-profile";

// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import execServerMainGo from "../../build-sidecars/exec-server/main.go" with { type: "text" };
// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import execServerGoMod from "../../build-sidecars/exec-server/go.mod" with { type: "text" };

/** The vendored Go exec-server sources, embedded for the build context. */
export const EXEC_SERVER_MAIN_GO: string = execServerMainGo;
export const EXEC_SERVER_GO_MOD: string = execServerGoMod;

/** Golang image used for the (static) exec-server build stage. Overridable via build-arg. */
export const DEFAULT_GO_BUILDER_IMAGE = "golang:1.23-bookworm";

/** The port the exec-server listens on inside a builder by default. */
export const DEFAULT_SIDECAR_PORT = 8080;

interface RuntimeSpec {
  /** FROM image for the runtime stage; `RUNTIME_VERSION` is substituted in. */
  base: (version: string) => string;
  /** Default RUNTIME_VERSION build-arg value. */
  defaultVersion: string;
  /** Extra RUN steps installing the runtime's build tooling. */
  toolchainSetup: string[];
  /** Human-readable list of tools baked in (for logs/docs). */
  tools: string;
}

const RUNTIME_SPECS: Record<SidecarRuntime, RuntimeSpec> = {
  node: {
    base: (v) => `node:${v}-bookworm-slim`,
    defaultVersion: "22",
    // corepack ships yarn + pnpm shims alongside the base's npm/npx.
    toolchainSetup: ["corepack enable"],
    tools: "node, npm, npx, yarn, pnpm",
  },
  python: {
    base: (v) => `python:${v}-slim-bookworm`,
    defaultVersion: "3.13",
    toolchainSetup: [
      "pip install --no-cache-dir --root-user-action=ignore poetry pytest ruff black mypy",
    ],
    tools: "python, pip, poetry, pytest, ruff, black, mypy",
  },
  java: {
    base: (v) => `eclipse-temurin:${v}-jdk`,
    defaultVersion: "21",
    toolchainSetup: [
      "apt-get update && apt-get install -y --no-install-recommends maven gradle && rm -rf /var/lib/apt/lists/*",
    ],
    tools: "java, javac, mvn, gradle",
  },
  go: {
    base: (v) => `golang:${v}-bookworm`,
    defaultVersion: "1.23",
    toolchainSetup: [],
    tools: "go, gofmt",
  },
  rust: {
    base: (v) => `rust:${v}-bookworm`,
    defaultVersion: "1",
    // rustfmt + clippy ship with the rust image but adding them is idempotent
    // and guards against minimal variants.
    toolchainSetup: ["rustup component add rustfmt clippy"],
    tools: "cargo, rustc, rustfmt, clippy",
  },
};

export interface SidecarImageConfig {
  runtime: SidecarRuntime;
  /** Overrides RUNTIME_VERSION; falls back to the runtime's default. */
  runtimeVersion?: string;
  /** Golang image for the exec-server build stage. */
  goBuilderImage?: string;
  /** Port baked into ENV/EXPOSE (default 8080). */
  port?: number;
}

export function defaultSidecarRuntimeVersion(runtime: SidecarRuntime): string {
  return RUNTIME_SPECS[runtime].defaultVersion;
}

export function sidecarRuntimeTools(runtime: SidecarRuntime): string {
  return RUNTIME_SPECS[runtime].tools;
}

export function isSidecarRuntime(value: string): value is SidecarRuntime {
  return (SIDECAR_RUNTIMES as readonly string[]).includes(value);
}

/**
 * Generate a multi-stage Dockerfile for a builder image:
 *   1. compile the vendored Go exec-server (static, CGO disabled);
 *   2. copy it onto the runtime toolchain base, running as a non-root user
 *      with a port-agnostic HEALTHCHECK.
 */
export function generateSidecarDockerfile(config: SidecarImageConfig): string {
  const runtime = config.runtime;
  const spec = RUNTIME_SPECS[runtime];
  if (!spec) {
    throw new Error(
      `Unknown sidecar runtime '${runtime}'. Use one of: ${SIDECAR_RUNTIMES.join(", ")}`
    );
  }
  const version = config.runtimeVersion || spec.defaultVersion;
  const goBuilder = config.goBuilderImage || DEFAULT_GO_BUILDER_IMAGE;
  const port = config.port ?? DEFAULT_SIDECAR_PORT;

  const toolchainLines = spec.toolchainSetup.map((step) => `RUN ${step}`).join("\n");

  return `# syntax=docker/dockerfile:1
# Heretic build-sidecar image — runtime: ${runtime} (${spec.tools})
# Generated by \`heretic-cli image build-sidecar ${runtime}\`.

# --- Stage 1: build the static Go exec-server -------------------------------
ARG GO_BUILDER_IMAGE=${goBuilder}
FROM \${GO_BUILDER_IMAGE} AS exec-build
WORKDIR /src
COPY exec-server/ ./
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/exec-server .

# --- Stage 2: runtime toolchain + exec-server -------------------------------
ARG RUNTIME_VERSION=${version}
FROM ${spec.base("${RUNTIME_VERSION}")}
${toolchainLines ? toolchainLines + "\n" : ""}
COPY --from=exec-build /out/exec-server /usr/local/bin/exec-server

# Non-root by default (gap F-2). The compose runner overrides \`user:\` to the
# caller's uid:gid at run time; this keeps a standalone \`docker run\` from
# writing root-owned artefacts into the shared workspace.
RUN useradd -m -s /bin/bash builder || true

ENV EXEC_SERVER_RUNTIME=${runtime} \\
    EXEC_SERVER_PORT=${port} \\
    EXEC_SERVER_CWD=/workspace
WORKDIR /workspace
EXPOSE ${port}

# Port-agnostic healthcheck: \`exec-server -healthcheck\` reads EXEC_SERVER_PORT,
# so nothing hard-codes the port (gap F-1). The compose runner overrides this
# with the resolved port anyway.
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=12 \\
    CMD ["exec-server", "-healthcheck"]

USER builder
CMD ["exec-server"]
`;
}
