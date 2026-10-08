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
import { createSshCommand } from "./commands/ssh";
import { createMnemoniaCommand } from "./commands/mnemoria";
import { runLocalValidate } from "./commands/local-validate";
import { runDoctor } from "./commands/doctor";
import { initLogger, getLogger, logRaw } from "./logger";
import { listPortPresets, PORT_PRESET_GROUPS, PORT_PRESETS } from "./utils/ports";
import { version } from "../package.json";

/** Accumulate a repeatable option's values into an array. */
function collectOption(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

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
    .command("port-presets")
    .description("List the port presets for 'run --port-preset' and 'extra.port_presets'")
    .action(() => {
      for (const [name, members] of Object.entries(PORT_PRESET_GROUPS)) {
        logRaw(`${name}: ${members.join(" + ")}`);
      }
      for (const [name, specs] of Object.entries(PORT_PRESETS)) {
        logRaw(`${name}: ${specs.join(", ")}`);
      }
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

  // SSH tool-execution backend setup/verification
  program.addCommand(createSshCommand());

  // Mnemoria memory server client command group
  program.addCommand(createMnemoniaCommand());

  // Agent run command - uses a generic command name pattern
  program
    .command("run <agent-name> [command...]")
    .description("Run an agent by profile name")
    .option("-d, --detach", "Run container in background (detached mode)", false)
    .option("-s, --session <name>", "Session name (default: 'default')")
    .option("--mcp <value>", "MCP server config (JSON string or path to .json file)")
    .option("--root", "Run the container as root (keeps /home/agent as HOME)")
    .option(
      "--sidecar <runtime>",
      "Enable a build sidecar for a runtime (repeatable): node|python|java|go|rust",
      collectOption,
      []
    )
    .option(
      "--builder-image <runtime=image>",
      "Override the builder image for a runtime, e.g. node=my-builder:latest (repeatable)",
      collectOption,
      []
    )
    .option("--disable-sidecars", "Disable all build sidecars for this run")
    .option(
      "-p, --port <spec>",
      "Publish a port or range, docker -p syntax: 3000, 3000-3020, 13000-13020:3000-3020, 127.0.0.1:8080:8080 (repeatable)",
      collectOption,
      []
    )
    .option(
      "--port-preset <name>",
      `Publish a preset of typical dev ports (repeatable, comma-separated): ${listPortPresets().join(", ")}`,
      collectOption,
      []
    )
    .option("--port-host-ip <ip>", "Host interface for ports that don't name one, e.g. 127.0.0.1")
    .option(
      "--port-offset <n>",
      "Shift host ports of presets and same-port specs, e.g. 10000 publishes 3000 as 13000"
    )
    .option("--no-ports", "Ignore the profile's ports and presets for this run")
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (agentName: string, command: string[], options) => {
      // `command` holds everything after the agent name (custom command to run
      // in the container). passThroughOptions() keeps its flags intact.
      const customCommand = command.length > 0 ? command : undefined;

      await runAgent(agentName, {
        detach: options.detach,
        command: customCommand,
        mcp: options.mcp,
        session: options.session,
        asRoot: options.root,
        sidecar: options.sidecar,
        builderImage: options.builderImage,
        disableSidecars: options.disableSidecars,
        port: options.port,
        portPreset: options.portPreset,
        portHostIp: options.portHostIp,
        portOffset: options.portOffset,
        ports: options.ports,
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
    const asRoot = argv.includes("--root") || undefined;
    const disableSidecars = argv.includes("--disable-sidecars") || undefined;

    // Parse --session / -s
    let session: string | undefined;
    const sessionLongIdx = argv.indexOf("--session");
    const sessionShortIdx = argv.indexOf("-s");
    const sessionIdx = sessionLongIdx >= 0 ? sessionLongIdx : sessionShortIdx;
    if (sessionIdx >= 0 && sessionIdx + 1 < argv.length) {
      session = argv[sessionIdx + 1];
    }

    // Collect all occurrences of a repeatable "--flag <value>" option.
    const collectFlag = (flag: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag && i + 1 < argv.length) {
          out.push(argv[i + 1]);
        }
      }
      return out;
    };
    const sidecar = collectFlag("--sidecar");
    const builderImage = collectFlag("--builder-image");

    // Find custom command after --
    const dashDashIndex = argv.indexOf("--");
    const customCommand = dashDashIndex >= 0 ? argv.slice(dashDashIndex + 1) : undefined;

    // Port flags, only before `--` (after it everything belongs to the command).
    const own = dashDashIndex >= 0 ? argv.slice(0, dashDashIndex) : argv;
    const valuesOf = (...flags: string[]): string[] =>
      own.flatMap((arg, i) => (flags.includes(arg) && i + 1 < own.length ? [own[i + 1]] : []));
    const port = valuesOf("--port", "-p");
    const portPreset = valuesOf("--port-preset");
    const portHostIp = valuesOf("--port-host-ip").at(-1);
    const portOffset = valuesOf("--port-offset").at(-1);
    const ports = own.includes("--no-ports") ? false : undefined;

    await runAgent(unknownCommand, {
      detach,
      command: customCommand,
      session,
      asRoot,
      sidecar,
      builderImage,
      disableSidecars,
      port,
      portPreset,
      portHostIp,
      portOffset,
      ports,
    });
  });

  return program;
}
