import { Command } from "commander";
import { runInit } from "./commands/init";
import { runLocalInit } from "./commands/localInit";
import { runUpdate } from "./commands/update";
import { runAgent } from "./commands/run-agent";
import { runPs } from "./commands/ps";
import { runStop } from "./commands/stop";
import { runAttach } from "./commands/attach";
import { createAgentsCommand } from "./commands/agents";
import { createImageCommand } from "./commands/image";
import { runLocalValidate } from "./commands/local-validate";
import { runDoctor } from "./commands/doctor";
import { initLogger, getLogger } from "./logger";
import { version } from "../package.json";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("heretic-cli")
    .description("VibeCoder Heretic CLI")
    .version(version, "-v, --version", "Show version information")
    .option("-V, --verbose", "Enable verbose logging")
    .option("--log-file <path>", "Write logs to a file")
    .enablePositionalOptions()
    .hook("preAction", (thisCommand) => {
      // Initialize logger before any command execution
      const opts = thisCommand.opts();
      initLogger({
        verbose: opts.verbose || false,
        logFile: opts.logFile,
      });
    });

  program
    .command("init")
    .description("Initialize a new heretic project")
    .action(async () => {
      await runInit();
    });

  program
    .command("local-init [profile]")
    .description("Initialize per-profile local override")
    .option("--compose", "Create compose.yaml template instead of per-profile config")
    .option("-f, --force", "Overwrite existing files")
    .action(async (profile: string | undefined, options) => {
      await runLocalInit(profile, {
        compose: options.compose,
        force: options.force,
      });
    });

  program
    .command("local-validate [profile]")
    .description("Validate local .heretic/cli/ configuration(s)")
    .action(async (profile?: string) => {
      await runLocalValidate(profile);
    });

  program
    .command("doctor")
    .description("Run environment health checks")
    .option("--fix", "Automatically fix issues where possible")
    .action(async (options) => {
      await runDoctor({ fix: options.fix });
    });

  program
    .command("update")
    .description("Check for updates and update the CLI")
    .action(async () => {
      await runUpdate([]);
    });

  program
    .command("ps")
    .description("List all running heretic agent containers")
    .option("--json", "Output as JSON")
    .option("-s, --session <name>", "Filter by session name")
    .addHelpText(
      "after",
      "\nExamples:\n  $ heretic-cli ps\n  $ heretic-cli ps --json\n  $ heretic-cli ps -s my-session"
    )
    .action(async (options) => {
      await runPs({ json: options.json, session: options.session });
    });

  program
    .command("stop [name]")
    .description("Stop running heretic agent container(s)")
    .option("--all", "Stop all heretic containers")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--keep", "Keep the container after stopping (don't remove)")
    .option("-s, --session <name>", "Filter by session name")
    .action(async (name: string | undefined, options) => {
      await runStop(name, {
        all: options.all,
        force: options.force,
        keep: options.keep,
        session: options.session,
      });
    });

  program
    .command("attach <name>")
    .description("Attach to a running heretic agent container")
    .option("-s, --session <name>", "Session name")
    .action(async (name: string, options) => {
      await runAttach(name, { session: options.session });
    });

  // Agents command group
  program.addCommand(createAgentsCommand());

  // Image build/generate command group
  program.addCommand(createImageCommand());

  // Agent run command - uses a generic command name pattern
  program
    .command("run <agent-name>")
    .description("Run an agent by profile name")
    .option("-d, --detach", "Run container in background (detached mode)", false)
    .option("-s, --session <name>", "Session name (default: 'default')")
    .option("--mcp <value>", "MCP server config (JSON string or path to .json file)")
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (agentName: string, options, cmd: Command) => {
      // Extract custom command arguments (everything after --)
      // Commander.js puts pass-through args in cmd.args after processing known options
      const unknownArgs = cmd.args.slice(1); // Skip agent name
      const customCommand = unknownArgs.length > 0 ? unknownArgs : undefined;

      await runAgent(agentName, {
        detach: options.detach,
        command: customCommand,
        mcp: options.mcp,
        session: options.session,
      });
    });

  // Global error handler
  program.exitOverride((err) => {
    if (err.code === "commander.help" || err.code === "commander.helpDisplayed") {
      process.exit(0);
    }
    if (err.code === "commander.version") {
      process.exit(0);
    }
    const logger = getLogger();
    logger.error(err.message);
    process.exit(1);
  });

  // Handle unknown commands as shortcuts to `run <agent-name>`
  // This allows `heretic-cli claude` instead of `heretic-cli run claude`
  program.on("command:*", async (operands: string[]) => {
    const unknownCommand = operands[0];

    // Treat as agent name - parse options from process.argv
    const argv = process.argv.slice(3); // Skip node, script, and agent name
    const detach = argv.includes("--detach") || argv.includes("-d");

    // Parse --session / -s
    let session: string | undefined;
    const sessionLongIdx = argv.indexOf("--session");
    const sessionShortIdx = argv.indexOf("-s");
    const sessionIdx = sessionLongIdx >= 0 ? sessionLongIdx : sessionShortIdx;
    if (sessionIdx >= 0 && sessionIdx + 1 < argv.length) {
      session = argv[sessionIdx + 1];
    }

    // Find custom command after --
    const dashDashIndex = argv.indexOf("--");
    const customCommand = dashDashIndex >= 0 ? argv.slice(dashDashIndex + 1) : undefined;

    await runAgent(unknownCommand, {
      detach,
      command: customCommand,
      session,
    });
  });

  return program;
}
