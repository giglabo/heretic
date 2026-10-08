import type { MnemoniaClient } from "./client";
import {
  MnemoniaAmbiguousError,
  MnemoniaNotFoundError,
  MnemoniaPalaceRequiredError,
} from "./errors";
import { collectAllPages } from "./pagination";
import type { PalaceResponse } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolve a palace identifier (UUID or name) to a concrete palace. When the
 * argument looks like a UUID it's fetched directly. Otherwise the full palace
 * list is fetched and matched case-insensitively by `name`. Ambiguous matches
 * raise MnemoniaAmbiguousError.
 */
export async function resolvePalace(
  client: MnemoniaClient,
  identifier: string
): Promise<PalaceResponse> {
  if (!identifier) throw new MnemoniaPalaceRequiredError();

  if (isUuid(identifier)) {
    return client.getPalace(identifier);
  }

  const palaces = await collectAllPages<PalaceResponse>(
    (req) => client.listPalaces(req),
    100,
    5000
  );
  const lower = identifier.toLowerCase();
  const exact = palaces.filter((p) => p.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new MnemoniaAmbiguousError(
      "palace",
      identifier,
      exact.map((p) => p.name)
    );
  }

  const prefix = palaces.filter((p) => p.name.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new MnemoniaAmbiguousError(
      "palace",
      identifier,
      prefix.map((p) => p.name)
    );
  }
  throw new MnemoniaNotFoundError("Palace", identifier);
}

/**
 * Resolve a palace ID with this priority:
 *   1. CLI flag (--palace)
 *   2. `MN_DEFAULT_PALACE` env var (already folded into config.defaults.palace)
 *   3. config.defaults.palace
 * Throws MnemoniaPalaceRequiredError when none are set.
 */
export async function resolvePalaceIdOrThrow(
  client: MnemoniaClient,
  options: { cliPalace?: string; defaultPalace?: string }
): Promise<string> {
  const raw = options.cliPalace || options.defaultPalace;
  if (!raw) throw new MnemoniaPalaceRequiredError();
  if (isUuid(raw)) return raw;
  const palace = await resolvePalace(client, raw);
  return palace.id;
}
