/**
 * argv normalization for `run <agent> [command...]`.
 *
 * `run` uses passThroughOptions() so a custom command's own flags survive
 * (`run cs npm test --watch`). The side effect is that heretic's own run options
 * typed AFTER the agent name (`run cs -s two --root`) would be passed through to
 * the container as its command instead of being parsed. Before parsing, we move
 * them in front of the agent name so Commander sees them, in any order.
 *
 * Which tokens are heretic's:
 * - the block of known `run` options (with their values) directly after the agent
 *   name — a custom command can't start with a flag, so it begins at the first
 *   token that isn't a known run option;
 * - a bare `--root` anywhere before `--` (kept from the original `--root` hoist).
 *
 * Tokens after a `--` separator belong to the custom command and are never
 * touched. The bare-agent shortcut (`heretic-cli cs ...`) parses argv itself and
 * is left alone.
 */

import type { Command } from "commander";

/** Option flag (`-s`, `--session`, `--no-ports`) → whether it takes a value. */
type OptionSpec = Map<string, boolean>;

function optionSpec(command: Command): OptionSpec {
  const spec: OptionSpec = new Map();
  for (const opt of command.options) {
    const takesValue = opt.required || opt.optional;
    if (opt.short) spec.set(opt.short, takesValue);
    if (opt.long) spec.set(opt.long, takesValue);
  }
  return spec;
}

/**
 * Number of tokens (1 or 2) the known option at `token` spans, or 0 when it is
 * not a known option. `--long=value` and `-sVALUE` are single tokens.
 */
function optionLength(token: string, next: string | undefined, spec: OptionSpec): number {
  if (spec.has(token)) return spec.get(token) && next !== undefined ? 2 : 1;
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 0 && spec.get(token.slice(0, eq))) return 1;
  if (/^-[^-]./.test(token) && spec.get(token.slice(0, 2))) return 1;
  return 0;
}

/**
 * Rewrite argv so `run` options given after the agent name are parsed as options.
 *
 * @param argv - Full argv (`[runtime, script, ...args]`)
 * @param program - The heretic program (source of the global and `run` option lists)
 * @returns argv with heretic's run options moved in front of the agent name
 */
export function normalizeRunArgv(argv: string[], program: Command): string[] {
  const run = program.commands.find((c) => c.name() === "run");
  if (!run) return argv;

  const sep = argv.indexOf("--");
  const end = sep === -1 ? argv.length : sep;
  const at = (i: number): string | undefined => (i < end ? argv[i] : undefined);

  // argv[0] = runtime, argv[1] = script path. Skip global options (`-V`,
  // `--log-file <path>`) to reach the command keyword.
  const globalSpec = optionSpec(program);
  let i = 2;
  while (i < end && argv[i].startsWith("-")) {
    i += optionLength(argv[i], at(i + 1), globalSpec) || 1;
  }
  if (at(i) !== "run") return argv;

  // Skip run options already given before the agent name.
  const runSpec = optionSpec(run);
  i++;
  while (i < end && argv[i].startsWith("-")) {
    const len = optionLength(argv[i], at(i + 1), runSpec);
    if (len === 0) return argv; // unknown option: leave it to Commander
    i += len;
  }
  const agentIdx = i;
  if (agentIdx >= end) return argv;

  // The option block right after the agent name is heretic's.
  const hoisted: string[] = [];
  i = agentIdx + 1;
  while (i < end) {
    const len = optionLength(argv[i], at(i + 1), runSpec);
    if (len === 0) break;
    hoisted.push(...argv.slice(i, i + len));
    i += len;
  }
  const rest = argv.slice(i);

  // A bare --root later in the command (before `--`) is heretic's too.
  const restEnd = sep === -1 ? rest.length : sep - i;
  const rootIdx = rest.slice(0, restEnd).indexOf("--root");
  if (rootIdx !== -1) {
    rest.splice(rootIdx, 1);
    hoisted.push("--root");
  }

  if (hoisted.length === 0) return argv;
  return [...argv.slice(0, agentIdx), ...hoisted, argv[agentIdx], ...rest];
}
