import type { Page, PageRequest } from "./types";

export interface PaginationFlags {
  limit?: number;
  after?: string;
  all?: boolean;
}

/**
 * Iterate through every page from a cursor-based list endpoint. Used when the
 * user passes --all. The caller provides a single function that fetches one
 * page given a PageRequest; this helper handles cursor threading.
 */
export async function collectAllPages<T>(
  fetchPage: (req: PageRequest) => Promise<Page<T>>,
  pageSize: number,
  hardLimit = 10_000
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (all.length < hardLimit) {
    const page: Page<T> = await fetchPage({ limit: pageSize, after: cursor });
    all.push(...page.items);
    if (!page.has_next) break;
    const next = page.next_cursor ?? undefined;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return all;
}

/**
 * Build a PageRequest from CLI flags using the configured page size as default.
 */
export function buildPageRequest(flags: PaginationFlags, defaultPageSize: number): PageRequest {
  return {
    limit: flags.limit ?? defaultPageSize,
    after: flags.after,
  };
}

/**
 * Wrap a single page in the JSON envelope we emit when `--json` is used. Used
 * by commands to keep the schema stable: every list endpoint in JSON mode
 * carries pagination metadata unless --all is passed (in which case the caller
 * should emit a flat array).
 */
export function pageEnvelope<T>(page: Page<T>): {
  items: T[];
  total?: number;
  has_next: boolean;
  has_previous: boolean;
  next_cursor: string | null;
  previous_cursor: string | null;
} {
  return {
    items: page.items,
    total: page.total,
    has_next: page.has_next,
    has_previous: page.has_previous,
    next_cursor: page.next_cursor ?? null,
    previous_cursor: page.previous_cursor ?? null,
  };
}
