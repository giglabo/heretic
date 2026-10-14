/**
 * Entrypoint script generation for Heretic Agent images.
 *
 * The script is embedded as a text asset so `bun build --compile` includes
 * it in the binary without template-literal escaping issues.
 */

// @ts-expect-error -- Bun text import (see types/text-imports.d.ts)
import entrypointScript from "./assets/entrypoint.sh" with { type: "text" };

/**
 * Generate the universal entrypoint.sh script for Heretic Agent containers.
 */
export function generateEntrypoint(): string {
  return entrypointScript;
}
