import { logRaw } from "../../logger";
import type { EffectiveMnemoniaConfig } from "./config-loader";

/**
 * Effective output mode. Derived from CLI flags > env var > config.defaults.output
 * > TTY auto-detection. Non-TTY stdout defaults to plain (no color, no table
 * borders) so piping into `jq`, `cut`, `awk` works.
 */
export type OutputMode = "table" | "json" | "plain";

export interface OutputContext {
  mode: OutputMode;
  color: boolean;
  idMode: "short" | "full";
  timestamps: "relative" | "absolute";
}

export interface OutputFlags {
  json?: boolean;
  plain?: boolean;
  noColor?: boolean;
  ids?: "short" | "full";
}

/**
 * Resolve the effective OutputContext given CLI flags and effective config.
 * Honors NO_COLOR, --no-color, --json, --plain, MN_OUTPUT.
 */
export function resolveOutput(
  config: EffectiveMnemoniaConfig,
  flags: OutputFlags = {}
): OutputContext {
  let mode: OutputMode;
  if (flags.json) mode = "json";
  else if (flags.plain) mode = "plain";
  else {
    const configured = config.defaults.output;
    if (configured === "json" || configured === "plain") {
      mode = configured;
    } else if (process.stdout.isTTY) {
      mode = "table";
    } else {
      mode = "plain";
    }
  }

  const colorSetting = config.output.color;
  let color: boolean;
  if (process.env.NO_COLOR) color = false;
  else if (flags.noColor) color = false;
  else if (colorSetting === "never") color = false;
  else if (colorSetting === "always") color = true;
  else color = Boolean(process.stdout.isTTY);

  return {
    mode,
    color,
    idMode: flags.ids ?? config.output.ids,
    timestamps: config.output.timestamps,
  };
}

// ---------- Colors ----------

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export function color(ctx: OutputContext, style: keyof typeof C, text: string): string {
  if (!ctx.color) return text;
  return `${C[style]}${text}${C.reset}`;
}

// ---------- ID & timestamp formatting ----------

export function formatId(id: string, ctx: OutputContext): string {
  if (!id) return "";
  if (ctx.idMode === "full") return id;
  return id.substring(0, 8);
}

export function formatTimestamp(iso: string | undefined, ctx: OutputContext): string {
  if (!iso) return "—";
  if (ctx.timestamps === "absolute") return iso;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const now = Date.now();
  const deltaMs = now - then;
  const abs = Math.abs(deltaMs);
  const sign = deltaMs >= 0 ? "" : "in ";
  const suffix = deltaMs >= 0 ? " ago" : "";
  if (abs < 60_000) return `${sign}${Math.max(1, Math.round(abs / 1000))}s${suffix}`;
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)}m${suffix}`;
  if (abs < 86_400_000) return `${sign}${Math.round(abs / 3_600_000)}h${suffix}`;
  if (abs < 30 * 86_400_000) return `${sign}${Math.round(abs / 86_400_000)}d${suffix}`;
  if (abs < 365 * 86_400_000) return `${sign}${Math.round(abs / (30 * 86_400_000))}mo${suffix}`;
  return `${sign}${Math.round(abs / (365 * 86_400_000))}y${suffix}`;
}

// ---------- Table rendering ----------

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  align?: "left" | "right";
}

export function renderTable<T>(rows: T[], columns: Column<T>[]): string {
  if (rows.length === 0) return "";
  const widths = columns.map((c) => c.header.length);
  const stringRows = rows.map((row) =>
    columns.map((c, i) => {
      const v = c.get(row) ?? "";
      widths[i] = Math.max(widths[i], visibleLength(v));
      return v;
    })
  );

  const sep = "  ";
  const headerLine = columns.map((c, i) => pad(c.header, widths[i], c.align)).join(sep);
  const bodyLines = stringRows.map((r) =>
    r.map((cell, i) => pad(cell, widths[i], columns[i].align)).join(sep)
  );
  return [headerLine, ...bodyLines].join("\n");
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  const vis = visibleLength(value);
  if (vis >= width) return value;
  const spaces = " ".repeat(width - vis);
  return align === "right" ? spaces + value : value + spaces;
}

// Strip ANSI codes so padding accounts for visible width only.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

// ---------- High-level emitters ----------

export function emit<T>(
  ctx: OutputContext,
  rows: T[],
  columns: Column<T>[],
  jsonShape?: unknown
): void {
  if (ctx.mode === "json") {
    logRaw(JSON.stringify(jsonShape ?? rows, null, 2));
    return;
  }
  if (ctx.mode === "plain") {
    for (const row of rows) {
      logRaw(columns.map((c) => c.get(row)).join("\t"));
    }
    return;
  }
  logRaw(renderTable(rows, columns));
}

export function emitJson(value: unknown): void {
  logRaw(JSON.stringify(value, null, 2));
}

export function emitLine(ctx: OutputContext, line: string): void {
  if (ctx.mode === "json") return;
  logRaw(line);
}

export function emitError(ctx: OutputContext, message: string, suggestion?: string): void {
  if (ctx.mode === "json") {
    logRaw(
      JSON.stringify(
        {
          error: {
            message,
            suggestion: suggestion ?? null,
          },
        },
        null,
        2
      )
    );
    return;
  }
  const errLabel = ctx.color ? `${C.red}Error${C.reset}` : "Error";
  logRaw(`${errLabel}: ${message}`);
  if (suggestion) {
    const hintLabel = ctx.color ? `${C.yellow}Hint${C.reset}` : "Hint";
    logRaw(`${hintLabel}: ${suggestion}`);
  }
}

// ---------- Error result object for JSON mode ----------

export interface JsonErrorShape {
  error: {
    code?: string;
    message: string;
    status?: number;
    suggestion?: string;
  };
}

export function formatError(
  message: string,
  opts?: { code?: string; status?: number; suggestion?: string }
): JsonErrorShape {
  return {
    error: {
      code: opts?.code,
      message,
      status: opts?.status,
      suggestion: opts?.suggestion,
    },
  };
}
