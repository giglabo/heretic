#!/usr/bin/env bun
import { createProgram } from "./cli";
import { applyPendingUpdate } from "./commands/update";

// Check and apply pending update before running CLI
const wasUpdated = await applyPendingUpdate();

if (wasUpdated) {
  // If update was applied, show new version and exit
  // User should run the command again
  process.exit(0);
}

const program = createProgram();
await program.parseAsync(Bun.argv);
