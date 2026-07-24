import { Command, Option } from "commander";
import { createStatusCommand } from "./status";
import { createConfigCommand } from "./config-cmd";
import { createPalaceCommand } from "./palace";
import { createWingCommand } from "./wing";
import { createRoomCommand } from "./room";
import {
  createStoreCommand,
  createGetCommand,
  createListDrawersCommand,
  createDeleteDrawerCommand,
} from "./drawer";
import { createSearchCommand } from "./search";
import { createEntityCommand } from "./entity";
import { createTripleCommand } from "./triple";
import { createGraphCommand } from "./graph";
import { createKeywordCommand } from "./keyword";
import { createFileCommand } from "./file";
import { createIngestCommand } from "./ingest";

/**
 * Build the `mnemoria` command group. All global options (server, profile,
 * output format) are declared here and propagated to subcommands via Commander's
 * `.optsWithGlobals()` helper.
 */
export function createMnemoniaCommand(): Command {
  const mn = new Command("mnemoria");
  mn.description("Mnemoria memory server client")
    .aliases(["mn"])
    .addOption(new Option("-s, --server <url>", "Override server URL"))
    .addOption(new Option("-p, --profile <name>", "Use named connection profile"))
    .addOption(new Option("-P, --palace <id|name>", "Override default palace"))
    .addOption(new Option("-j, --json", "JSON output"))
    .addOption(new Option("--plain", "Plain tab-separated output"))
    .addOption(new Option("--no-color", "Disable color"))
    .addOption(new Option("--ids <mode>", "UUID display mode").choices(["short", "full"]));

  mn.addCommand(createStatusCommand());
  mn.addCommand(createConfigCommand());
  mn.addCommand(createPalaceCommand());
  mn.addCommand(createWingCommand());
  mn.addCommand(createRoomCommand());
  mn.addCommand(createStoreCommand());
  mn.addCommand(createGetCommand());
  mn.addCommand(createListDrawersCommand());
  mn.addCommand(createDeleteDrawerCommand());
  mn.addCommand(createSearchCommand());
  mn.addCommand(createEntityCommand());
  mn.addCommand(createTripleCommand());
  mn.addCommand(createGraphCommand());
  mn.addCommand(createKeywordCommand());
  mn.addCommand(createFileCommand());
  mn.addCommand(createIngestCommand());

  return mn;
}
