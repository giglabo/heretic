#!/usr/bin/env bun
import { createProgram } from "./cli";
import { applyPendingUpdate } from "./commands/update";

/**
 * The `run` command uses passThroughOptions() so a custom command's own flags
 * survive (e.g. `run cs npm test --watch`). A side effect is that heretic's own
 * `--root` flag is also passed through (and ignored) when it appears AFTER the
 * agent name. Hoist a bare `--root` to just after the command keyword so it is
 * parsed as an option regardless of position. Tokens after a `--` separator
 * belong to the custom command and are never touched.
 */
function hoistRootFlag(argv: string[]): string[] {
  const sep = argv.indexOf("--");
  const scanEnd = sep === -1 ? argv.length : sep;

  // argv[0] = runtime, argv[1] = script path; the command keyword starts at 2.
  let rootIdx = -1;
  for (let i = 2; i < scanEnd; i++) {
    if (argv[i] === "--root") {
      rootIdx = i;
      break;
    }
  }
  if (rootIdx === -1) return argv;

  // First non-flag token is the command keyword (`run` or an agent shortcut).
  let cmdIdx = -1;
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith("-")) {
      cmdIdx = i;
      break;
    }
  }
  if (cmdIdx === -1 || cmdIdx + 1 >= rootIdx) return argv; // already positioned

  const result = [...argv];
  result.splice(rootIdx, 1);
  result.splice(cmdIdx + 1, 0, "--root");
  return result;
}

// Check and apply pending update before running CLI
const wasUpdated = await applyPendingUpdate();

if (wasUpdated) {
  // If update was applied, show new version and exit
  // User should run the command again
  process.exit(0);
}

const program = createProgram();
await program.parseAsync(hoistRootFlag(Bun.argv));
