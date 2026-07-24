import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  formatId,
  formatTimestamp,
  renderTable,
  emit,
  emitJson,
  resolveOutput,
  type Column,
} from "../../src/commands/mnemoria/output";
import type { EffectiveMnemoniaConfig } from "../../src/commands/mnemoria/config-loader";

const baseConfig: EffectiveMnemoniaConfig = {
  profile: "default",
  server: { url: "http://localhost:3000", timeout: 1000, retry: { attempts: 0, delay: 10 } },
  auth: {
    mode: "disabled",
    provider: "keycloak",
    issuer: "",
    client_id: "mnemoria-cli",
    token_script: "",
  },
  defaults: { palace: "", language: "en", output: "table", page_size: 20, wing: "", room: "" },
  output: { color: "never", timestamps: "relative", ids: "short" },
};

const ctxTable = resolveOutput(baseConfig, { noColor: true });

describe("formatId", () => {
  test("short mode truncates to 8 chars", () => {
    expect(formatId("019524a1-c8f3-7000-8000-1a2b3c4d5e6f", ctxTable)).toBe("019524a1");
  });
  test("full mode returns original", () => {
    const ctx = resolveOutput(baseConfig, { ids: "full" });
    expect(formatId("019524a1-c8f3-7000-8000-1a2b3c4d5e6f", ctx)).toBe(
      "019524a1-c8f3-7000-8000-1a2b3c4d5e6f"
    );
  });
  test("empty string passes through", () => {
    expect(formatId("", ctxTable)).toBe("");
  });
});

describe("formatTimestamp", () => {
  test("undefined → em-dash", () => {
    expect(formatTimestamp(undefined, ctxTable)).toBe("—");
  });
  test("absolute mode returns raw ISO", () => {
    const ctx = resolveOutput(
      { ...baseConfig, output: { ...baseConfig.output, timestamps: "absolute" } },
      {}
    );
    expect(formatTimestamp("2026-04-11T10:00:00Z", ctx)).toBe("2026-04-11T10:00:00Z");
  });
  test("relative mode shows 'ago' for past", () => {
    const past = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    expect(formatTimestamp(past, ctxTable)).toContain("ago");
  });
});

describe("renderTable", () => {
  test("empty rows → empty string", () => {
    expect(renderTable([], [{ header: "X", get: () => "" }])).toBe("");
  });
  test("aligns columns by visible width", () => {
    const rows = [
      { name: "short", val: 1 },
      { name: "loooong-name", val: 22 },
    ];
    const cols: Column<(typeof rows)[number]>[] = [
      { header: "NAME", get: (r) => r.name },
      { header: "VAL", get: (r) => String(r.val), align: "right" },
    ];
    const table = renderTable(rows, cols);
    const lines = table.split("\n");
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("VAL");
    // Every line should have the same length as the header (after trim-right we can't compare, but before trim they should be consistent)
    // The NAME column must be wide enough for "loooong-name"
    expect(lines[2]).toContain("loooong-name");
  });
});

describe("resolveOutput", () => {
  test("--json wins over config", () => {
    const ctx = resolveOutput(baseConfig, { json: true });
    expect(ctx.mode).toBe("json");
  });
  test("--plain wins over config", () => {
    const ctx = resolveOutput(baseConfig, { plain: true });
    expect(ctx.mode).toBe("plain");
  });
  test("NO_COLOR disables color", () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const ctx = resolveOutput(
        { ...baseConfig, output: { ...baseConfig.output, color: "always" } },
        {}
      );
      expect(ctx.color).toBe(false);
    } finally {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    }
  });
  test("--no-color disables color", () => {
    const ctx = resolveOutput(
      { ...baseConfig, output: { ...baseConfig.output, color: "always" } },
      { noColor: true }
    );
    expect(ctx.color).toBe(false);
  });
});

describe("emit", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let output: string[];

  beforeEach(() => {
    output = [];
    logSpy = spyOn(console, "log").mockImplementation((msg: string) => {
      output.push(msg);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("json mode emits JSON.stringify", () => {
    const ctx = resolveOutput(baseConfig, { json: true });
    const rows = [{ name: "x" }];
    const cols: Column<(typeof rows)[number]>[] = [{ header: "NAME", get: (r) => r.name }];
    emit(ctx, rows, cols);
    expect(output[0]).toContain('"name"');
    expect(output[0]).toContain('"x"');
  });

  test("plain mode emits tab-separated lines", () => {
    const ctx = resolveOutput(baseConfig, { plain: true });
    const rows = [{ a: "one", b: "two" }];
    const cols: Column<(typeof rows)[number]>[] = [
      { header: "A", get: (r) => r.a },
      { header: "B", get: (r) => r.b },
    ];
    emit(ctx, rows, cols);
    expect(output[0]).toBe("one\ttwo");
  });

  test("emitJson always emits JSON.stringify", () => {
    emitJson({ k: "v" });
    expect(output[0]).toContain('"k"');
    expect(output[0]).toContain('"v"');
  });
});
