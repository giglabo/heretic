import { describe, test, expect } from "bun:test";
import {
  buildPageRequest,
  collectAllPages,
  pageEnvelope,
} from "../../src/commands/mnemoria/pagination";
import type { Page } from "../../src/commands/mnemoria/types";

function makePage<T>(items: T[], cursor?: string): Page<T> {
  return {
    items,
    has_next: cursor !== undefined,
    has_previous: false,
    next_cursor: cursor ?? null,
    total: items.length,
  };
}

describe("pagination", () => {
  test("buildPageRequest uses flags over default", () => {
    expect(buildPageRequest({ limit: 5 }, 20)).toEqual({ limit: 5, after: undefined });
  });

  test("buildPageRequest falls back to default page size", () => {
    expect(buildPageRequest({}, 20)).toEqual({ limit: 20, after: undefined });
  });

  test("collectAllPages threads cursor", async () => {
    const pages = [makePage([1, 2], "cursor-2"), makePage([3, 4], "cursor-3"), makePage([5])];
    let idx = 0;
    const fetchPage = async (): Promise<Page<number>> => {
      return pages[idx++];
    };
    const all = await collectAllPages<number>(fetchPage, 2);
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });

  test("collectAllPages stops on repeated cursor", async () => {
    const fetchPage = async (): Promise<Page<number>> => makePage([1], "stuck");
    const all = await collectAllPages<number>(fetchPage, 1, 100);
    // Should not loop forever: seen set breaks out
    expect(all.length).toBeLessThan(50);
  });

  test("collectAllPages respects hardLimit", async () => {
    let n = 0;
    const fetchPage = async (): Promise<Page<number>> => {
      return makePage([n++], String(n));
    };
    const all = await collectAllPages<number>(fetchPage, 1, 3);
    expect(all.length).toBeLessThanOrEqual(3);
  });

  test("pageEnvelope coerces null cursors", () => {
    const envelope = pageEnvelope(makePage([1]));
    expect(envelope.next_cursor).toBeNull();
    expect(envelope.previous_cursor).toBeNull();
    expect(envelope.items).toEqual([1]);
  });
});
