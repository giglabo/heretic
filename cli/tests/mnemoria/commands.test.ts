import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMnemoniaCommand } from "../../src/commands/mnemoria";
import {
  setPathProvider,
  resetPathProvider,
  TestProfilePathProvider,
} from "../../src/utils/profile-paths";

/**
 * Helper to invoke a `mnemoria` subcommand end-to-end. The returned `output`
 * array captures everything emitted via `logRaw`/`console.log`, and any
 * thrown process.exit is surfaced as a number.
 */
async function runMn(argv: string[]): Promise<{ output: string[]; exitCode: number | null }> {
  const output: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((msg: string) => {
    output.push(String(msg));
  });
  let exitCode: number | null = null;
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as never);

  try {
    const cmd = createMnemoniaCommand();
    cmd.exitOverride();
    await cmd.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("__exit_")) {
      // Commander's help/version exits surface here too; ignore.
      if (!(err as { code?: string })?.code?.startsWith("commander.")) {
        // Real error — let the test see it
        throw err;
      }
    }
  } finally {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { output, exitCode };
}

describe("mnemoria commands (E2E with mocked fetch)", () => {
  let tmp: string;
  let fetchSpy: ReturnType<typeof mock>;
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mn-cmd-"));
    setPathProvider(new TestProfilePathProvider(tmp));
    // Write a config that disables retries so connection-failure tests don't
    // time out under the default 3-retry exponential backoff.
    mkdirSync(join(tmp, "mnemoria"), { recursive: true });
    writeFileSync(
      join(tmp, "mnemoria", "config.yaml"),
      "server:\n  timeout: 500\n  retry:\n    attempts: 0\n    delay: 1\n"
    );
    // Disable auth so the client doesn't need tokens.
    process.env.MN_AUTH_MODE = "disabled";
    process.env.MN_SERVER_URL = "http://localhost:3000";
    delete process.env.MN_OUTPUT;
    delete process.env.MN_DEFAULT_PALACE;
    fetchSpy = mock(async () => new Response("{}"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    resetPathProvider();
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    globalThis.fetch = originalFetch;
  });

  test("status with unreachable server exits with code 3", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    const { exitCode, output } = await runMn(["status"]);
    expect(exitCode).toBe(3);
    const joined = output.join("\n");
    expect(joined.toLowerCase()).toContain("server");
  });

  test("status --json emits machine-readable output when reachable", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/health/ready")) {
        return new Response(JSON.stringify({ live: true, ready: true, version: "1.2.3" }));
      }
      if (url.endsWith("/api/v1/palaces")) {
        return new Response(
          JSON.stringify({ items: [], total: 0, has_next: false, has_previous: false })
        );
      }
      return new Response("{}");
    });
    const { output } = await runMn(["status", "--json"]);
    const json = JSON.parse(output[0]);
    expect(json.server.reachable).toBe(true);
    expect(json.server.version).toBe("1.2.3");
  });

  test("palace list --json renders envelope", async () => {
    fetchSpy.mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "019524a1-c8f3-7000-8000-1a2b3c4d5e6f",
              name: "acme",
              language: "en",
              embedding_dimensions: 1536,
              drawer_count: 10,
              entity_count: 2,
              created_at: "2026-04-01T10:00:00Z",
            },
          ],
          total: 1,
          has_next: false,
          has_previous: false,
        })
      );
    });
    const { output } = await runMn(["palace", "list", "--json"]);
    const json = JSON.parse(output[0]);
    expect(json.items[0].name).toBe("acme");
    expect(json.items[0].id.length).toBe(36);
  });

  test("palace list --plain emits tab-separated rows", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "019524a1-c8f3-7000-8000-1a2b3c4d5e6f",
                name: "acme",
                language: "en",
                embedding_dimensions: 1536,
                drawer_count: 10,
                entity_count: 2,
                created_at: "2026-04-01T10:00:00Z",
              },
            ],
            total: 1,
            has_next: false,
            has_previous: false,
          })
        )
    );
    const { output } = await runMn(["palace", "list", "--plain"]);
    expect(output.length).toBeGreaterThan(0);
    expect(output[0]).toContain("\t");
    expect(output[0]).toContain("acme");
  });

  test("search requires a query or --keyword/--entity", async () => {
    process.env.MN_DEFAULT_PALACE = "019524a1-c8f3-7000-8000-1a2b3c4d5e6f";
    const { exitCode } = await runMn(["search"]);
    expect(exitCode).toBe(1);
  });

  test("search with query POSTs /search", async () => {
    process.env.MN_DEFAULT_PALACE = "019524a1-c8f3-7000-8000-1a2b3c4d5e6f";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "019524a3-c8f3-7000-8000-1a2b3c4d5e6f",
                type: "semantic",
                score: 0.9,
                content: "hello world",
                created_at: "2026-04-10T00:00:00Z",
              },
            ],
            mode_counts: { semantic: 1 },
            total: 1,
          })
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "019524a1-c8f3-7000-8000-1a2b3c4d5e6f",
              name: "acme",
              language: "en",
              embedding_dimensions: 1536,
              created_at: "2026-04-01T10:00:00Z",
            },
          ],
          has_next: false,
          has_previous: false,
        })
      );
    });
    const { output } = await runMn(["search", "hello", "--json"]);
    const searchCall = calls.find((c) => c.url.includes("/search"));
    expect(searchCall).toBeDefined();
    expect(searchCall!.init?.method).toBe("POST");
    const json = JSON.parse(output[0]);
    expect(json.items[0].content).toBe("hello world");
  });

  test("store sends POST /drawers with inline content", async () => {
    process.env.MN_DEFAULT_PALACE = "019524a1-c8f3-7000-8000-1a2b3c4d5e6f";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/drawers") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "019524a3-c8f3-7000-8000-1a2b3c4d5e6f",
            content: "hello",
            created_at: "2026-04-10T00:00:00Z",
          })
        );
      }
      return new Response("{}");
    });
    const { output } = await runMn(["store", "hello there", "--json"]);
    const drawerCall = calls.find((c) => c.url.includes("/drawers") && c.init?.method === "POST");
    expect(drawerCall).toBeDefined();
    const body = JSON.parse(drawerCall!.init!.body as string);
    expect(body.content).toBe("hello there");
    expect(output.length).toBeGreaterThan(0);
  });
});
