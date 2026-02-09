/**
 * Inline resource scripts for Docker image builds.
 *
 * Imported as text via Bun's `import ... with { type: "text" }` so that
 * `bun build --compile` embeds them in the binary.
 */

// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import sidecarStub from "./assets/sidecar-exec-stub" with { type: "text" };
// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import sshExec from "./assets/ssh-exec" with { type: "text" };

export const SIDECAR_EXEC_STUB: string = sidecarStub;
export const SSH_EXEC_SCRIPT: string = sshExec;
