import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { MnemoniaClient } from "../../src/commands/mnemoria/client";
import {
  MnemoniaAuthError,
  MnemoniaConflictError,
  MnemoniaConnectionError,
  MnemoniaForbiddenError,
  MnemoniaNotFoundError,
  MnemoniaRateLimitError,
  MnemoniaServerError,
  MnemoniaTimeoutError,
  MnemoniaValidationError,
} from "../../src/commands/mnemoria/errors";

function makeResponse(body: unknown, init: ResponseInit & { text?: string } = {}): Response {
  const text = init.text ?? (body === undefined ? "" : JSON.stringify(body));
  return new Response(text, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: init.headers,
  });
}

function makeClient(overrides: Partial<ConstructorParameters<typeof MnemoniaClient>[0]> = {}) {
  return new MnemoniaClient({
    baseUrl: "http://localhost:3000",
    timeout: 1000,
    retry: { attempts: 0, delay: 10 },
    getToken: async () => "test-token",
    ...overrides,
  });
}

describe("MnemoniaClient", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("constructs URLs by trimming trailing slashes", async () => {
    const client = makeClient({ baseUrl: "http://localhost:3000/" });
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ items: [], has_next: false, has_previous: false })
    );
    await client.listPalaces();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:3000/api/v1/palaces");
  });

  test("sends bearer token in Authorization header", async () => {
    const client = makeClient({ getToken: async () => "abc123" });
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ items: [], has_next: false, has_previous: false })
    );
    await client.listPalaces();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc123");
  });

  test("omits Authorization when token provider returns null", async () => {
    const client = makeClient({ getToken: async () => null });
    fetchSpy.mockResolvedValueOnce(makeResponse({ live: true, ready: true }));
    await client.healthCheck();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("skipAuth on healthCheck does not call token provider", async () => {
    let called = false;
    const client = makeClient({
      getToken: async () => {
        called = true;
        return "tok";
      },
    });
    fetchSpy.mockResolvedValueOnce(makeResponse({ live: true, ready: true }));
    await client.healthCheck();
    expect(called).toBe(false);
  });

  test("maps 400 → MnemoniaValidationError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ error: { message: "bad field" } }, { status: 400 })
    );
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaValidationError);
  });

  test("maps 401 → MnemoniaAuthError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ message: "expired" }, { status: 401 }));
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaAuthError);
  });

  test("maps 403 → MnemoniaForbiddenError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ message: "nope" }, { status: 403 }));
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaForbiddenError);
  });

  test("maps 404 → MnemoniaNotFoundError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ message: "gone" }, { status: 404 }));
    await expect(client.getPalace("x")).rejects.toBeInstanceOf(MnemoniaNotFoundError);
  });

  test("maps 409 → MnemoniaConflictError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ message: "dup" }, { status: 409 }));
    await expect(client.createPalace({ name: "x", language: "en" })).rejects.toBeInstanceOf(
      MnemoniaConflictError
    );
  });

  test("maps 422 → MnemoniaValidationError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ message: "bad" }, { status: 422 }));
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaValidationError);
  });

  test("maps 429 → MnemoniaRateLimitError with retry-after", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ message: "slow" }, { status: 429, headers: { "retry-after": "12" } })
    );
    try {
      await client.listPalaces();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MnemoniaRateLimitError);
      expect((err as MnemoniaRateLimitError).retryAfterSeconds).toBe(12);
    }
  });

  test("maps 500 without retries → MnemoniaServerError", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ message: "boom" }, { status: 500 }));
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaServerError);
  });

  test("retries on 5xx when retry.attempts > 0", async () => {
    const client = makeClient({ retry: { attempts: 2, delay: 1 } });
    fetchSpy
      .mockResolvedValueOnce(makeResponse({ message: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(makeResponse({ message: "boom2" }, { status: 503 }))
      .mockResolvedValueOnce(makeResponse({ items: [], has_next: false, has_previous: false }));
    const result = await client.listPalaces();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.items).toEqual([]);
  });

  test("network error maps to MnemoniaConnectionError", async () => {
    const client = makeClient();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaConnectionError);
  });

  test("AbortError maps to MnemoniaTimeoutError", async () => {
    const client = makeClient();
    const err = new Error("aborted");
    err.name = "TimeoutError";
    fetchSpy.mockRejectedValueOnce(err);
    await expect(client.listPalaces()).rejects.toBeInstanceOf(MnemoniaTimeoutError);
  });

  test("query params are URL-encoded", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      makeResponse({ items: [], has_next: false, has_previous: false })
    );
    await client.listPalaces({ limit: 10, after: "cursor 1" });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("limit=10");
    expect(url).toContain("after=cursor+1");
  });

  test("createPalace sends POST with JSON body", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      makeResponse({
        id: "p1",
        name: "test",
        language: "en",
        embedding_dimensions: 1536,
        created_at: "2026-04-11T10:00:00Z",
      })
    );
    await client.createPalace({ name: "test", language: "en" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "test", language: "en" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("deletePalace on 204 returns undefined", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await client.deletePalace("p1");
    expect(result).toBeUndefined();
  });

  test("search sends POST to /search", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(makeResponse({ items: [], mode_counts: {}, total: 0 }));
    await client.search("p1", { query: "hello" });
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toContain("/api/v1/palaces/p1/search");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  test("uploadToPresigned sends raw bytes with content-type", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const data = new Uint8Array([1, 2, 3, 4]);
    await client.uploadToPresigned("https://s3.example/upload", data, "image/png");
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe("https://s3.example/upload");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
  });
});
