import { describe, test, expect } from "bun:test";
import {
  isUuid,
  resolvePalace,
  resolvePalaceIdOrThrow,
} from "../../src/commands/mnemoria/palace-resolver";
import type { MnemoniaClient } from "../../src/commands/mnemoria/client";
import type { PalaceResponse, Page } from "../../src/commands/mnemoria/types";
import {
  MnemoniaAmbiguousError,
  MnemoniaNotFoundError,
  MnemoniaPalaceRequiredError,
} from "../../src/commands/mnemoria/errors";

const palaceFixture = (id: string, name: string): PalaceResponse => ({
  id,
  name,
  language: "en",
  embedding_dimensions: 1536,
  created_at: "2026-04-01T00:00:00Z",
});

function makeMockClient(palaces: PalaceResponse[]): MnemoniaClient {
  return {
    async getPalace(id: string): Promise<PalaceResponse> {
      const found = palaces.find((p) => p.id === id);
      if (!found) throw new Error(`not found: ${id}`);
      return found;
    },
    async listPalaces(): Promise<Page<PalaceResponse>> {
      return {
        items: palaces,
        has_next: false,
        has_previous: false,
        total: palaces.length,
      };
    },
  } as unknown as MnemoniaClient;
}

describe("isUuid", () => {
  test("accepts canonical UUID", () => {
    expect(isUuid("019524a1-c8f3-7000-8000-1a2b3c4d5e6f")).toBe(true);
  });
  test("rejects short name", () => {
    expect(isUuid("acme-project")).toBe(false);
  });
});

describe("resolvePalace", () => {
  test("UUID is fetched directly via getPalace", async () => {
    const client = makeMockClient([palaceFixture("019524a1-c8f3-7000-8000-1a2b3c4d5e6f", "acme")]);
    const result = await resolvePalace(client, "019524a1-c8f3-7000-8000-1a2b3c4d5e6f");
    expect(result.name).toBe("acme");
  });

  test("exact name match", async () => {
    const client = makeMockClient([
      palaceFixture("p1", "acme-project"),
      palaceFixture("p2", "personal-notes"),
    ]);
    const result = await resolvePalace(client, "acme-project");
    expect(result.id).toBe("p1");
  });

  test("case-insensitive match", async () => {
    const client = makeMockClient([palaceFixture("p1", "AcmeProject")]);
    const result = await resolvePalace(client, "acmeproject");
    expect(result.id).toBe("p1");
  });

  test("unique prefix match falls through", async () => {
    const client = makeMockClient([palaceFixture("p1", "acme-project")]);
    const result = await resolvePalace(client, "acme");
    expect(result.id).toBe("p1");
  });

  test("ambiguous name → MnemoniaAmbiguousError", async () => {
    const client = makeMockClient([
      palaceFixture("p1", "acme-project"),
      palaceFixture("p2", "acme-staging"),
    ]);
    await expect(resolvePalace(client, "acme")).rejects.toBeInstanceOf(MnemoniaAmbiguousError);
  });

  test("no match → MnemoniaNotFoundError", async () => {
    const client = makeMockClient([palaceFixture("p1", "acme")]);
    await expect(resolvePalace(client, "nothing")).rejects.toBeInstanceOf(MnemoniaNotFoundError);
  });
});

describe("resolvePalaceIdOrThrow", () => {
  test("throws when neither CLI flag nor default is set", async () => {
    const client = makeMockClient([]);
    await expect(resolvePalaceIdOrThrow(client, {})).rejects.toBeInstanceOf(
      MnemoniaPalaceRequiredError
    );
  });

  test("CLI flag beats default", async () => {
    const client = makeMockClient([
      palaceFixture("p1", "cli-one"),
      palaceFixture("p2", "default-one"),
    ]);
    const id = await resolvePalaceIdOrThrow(client, {
      cliPalace: "cli-one",
      defaultPalace: "default-one",
    });
    expect(id).toBe("p1");
  });

  test("uses default when CLI flag missing", async () => {
    const client = makeMockClient([palaceFixture("p2", "default-one")]);
    const id = await resolvePalaceIdOrThrow(client, {
      defaultPalace: "default-one",
    });
    expect(id).toBe("p2");
  });

  test("UUID is returned as-is without resolution", async () => {
    const client = makeMockClient([]);
    const id = await resolvePalaceIdOrThrow(client, {
      cliPalace: "019524a1-c8f3-7000-8000-1a2b3c4d5e6f",
    });
    expect(id).toBe("019524a1-c8f3-7000-8000-1a2b3c4d5e6f");
  });
});
