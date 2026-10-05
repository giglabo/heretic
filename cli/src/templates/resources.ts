/**
 * Inline resource scripts for Docker image builds.
 *
 * Imported as text via Bun's `import ... with { type: "text" }` so that
 * `bun build --compile` embeds them in the binary.
 */

// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import sidecarExec from "./assets/sidecar-exec" with { type: "text" };
// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import sshExec from "./assets/ssh-exec" with { type: "text" };

/**
 * The real `sidecar-exec` client baked at `/opt/sidecar/sidecar-exec`.
 * Routes wrapped commands to an HTTP build sidecar (`POST /exec`).
 * (Replaces the previous always-failing stub — spec gap C-21.)
 */
export const SIDECAR_EXEC_SCRIPT: string = sidecarExec;
export const SSH_EXEC_SCRIPT: string = sshExec;
