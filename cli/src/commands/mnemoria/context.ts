import { MnemoniaClient } from "./client";
import { createTokenProvider } from "./auth";
import { loadEffectiveConfig, type EffectiveMnemoniaConfig } from "./config-loader";
import { resolveOutput, type OutputContext, type OutputFlags } from "./output";
import { MnemoniaError, EXIT_GENERAL } from "./errors";
import { getLogger, logRaw } from "../../logger";
import { emitError } from "./output";

/**
 * Global flags inherited from `heretic-cli mnemoria [options]`. These are
 * merged into the OutputContext and passed through to command handlers.
 */
export interface MnemoniaGlobalFlags extends OutputFlags {
  server?: string;
  profile?: string;
  palace?: string;
}

export interface MnemoniaCommandContext {
  config: EffectiveMnemoniaConfig;
  client: MnemoniaClient;
  out: OutputContext;
  flags: MnemoniaGlobalFlags;
}

/**
 * Build a per-command context from the parent command's options. Called at
 * the top of every mnemoria subcommand so flags like `--server`, `--profile`,
 * `--json` are honored uniformly.
 */
export function buildContext(flags: MnemoniaGlobalFlags): MnemoniaCommandContext {
  const config = loadEffectiveConfig({
    profile: flags.profile,
    cliOverrides: {
      serverUrl: flags.server,
      output: flags.json ? "json" : flags.plain ? "plain" : undefined,
      palace: flags.palace,
    },
  });

  const client = new MnemoniaClient({
    baseUrl: config.server.url,
    timeout: config.server.timeout,
    retry: config.server.retry,
    getToken: createTokenProvider(config),
  });

  const out = resolveOutput(config, flags);

  return { config, client, out, flags };
}

/**
 * Wrap a command action so any thrown MnemoniaError is rendered consistently
 * (via OutputContext) and exits with the error's declared exit code. Logger
 * records the full stack at debug level for --verbose troubleshooting.
 */
export function runCommand(
  flagsAccessor: () => MnemoniaGlobalFlags,
  handler: (ctx: MnemoniaCommandContext) => Promise<void>
): () => Promise<void> {
  return async () => {
    const logger = getLogger();
    let ctx: MnemoniaCommandContext | undefined;
    try {
      ctx = buildContext(flagsAccessor());
      await handler(ctx);
    } catch (err) {
      const out = ctx?.out;
      if (err instanceof MnemoniaError) {
        logger.debug({ err }, "mnemoria command failed");
        if (out) {
          emitError(out, err.message, err.suggestion);
        } else {
          logRaw(`Error: ${err.message}`);
          if (err.suggestion) logRaw(`Hint: ${err.suggestion}`);
        }
        process.exit(err.exitCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "mnemoria command failed");
      if (out) {
        emitError(out, message);
      } else {
        logRaw(`Error: ${message}`);
      }
      process.exit(EXIT_GENERAL);
    }
  };
}

/**
 * Merge global flags from a parent Commander command with subcommand-level
 * flags. Commander surfaces parent options via `.optsWithGlobals()` — we
 * centralize extraction so every subcommand uses the same spelling.
 */
export function extractGlobalFlags(opts: Record<string, unknown>): MnemoniaGlobalFlags {
  return {
    server: asString(opts.server),
    profile: asString(opts.profile),
    palace: asString(opts.palace),
    json: Boolean(opts.json),
    plain: Boolean(opts.plain),
    noColor: Boolean(opts.noColor),
    ids: opts.ids === "full" ? "full" : opts.ids === "short" ? "short" : undefined,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
