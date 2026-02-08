import { Command } from "commander";
import inquirer from "inquirer";
import { getLogger, logRaw } from "../logger";
import {
  loadAllProfiles,
  loadProfile,
  saveProfile,
  getProfilesDir,
  validateProfile,
  validateProfileDetailed,
  listProfiles,
} from "../utils/profile-loader";
import {
  hasLocalConfig,
  loadLocalConfig,
  saveLocalConfig,
  listLocalConfigs,
} from "../utils/local-config";
import { promptList } from "../utils/prompt";
import { resolveConfig } from "../utils/config-resolver";
import { maskToken, getHereticDir } from "../utils/settings";
import {
  isDockerAvailable,
  listContainers,
  getDockerClient,
  stopContainer,
  removeContainer,
} from "../utils/docker";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseYaml, stringifyYaml } from "../utils/yaml";
import { parseMcpJson } from "../runners/mcp-helper";
import type { AgentProfile, McpServer, VolumeMount } from "../types/agent-profile";

interface ListAgentsOptions {
  json?: boolean;
}

interface AgentListItem {
  name: string;
  image: string;
  runner: string;
  local: boolean;
}

/**
 * Format table with aligned columns
 */
function formatTable(data: AgentListItem[]): string {
  if (data.length === 0) {
    return "";
  }

  // Calculate column widths
  const nameWidth = Math.max(4, ...data.map((d) => d.name.length));
  const imageWidth = Math.max(5, ...data.map((d) => d.image.length));
  const runnerWidth = Math.max(6, ...data.map((d) => d.runner.length));
  const localWidth = 5; // "LOCAL" or "✓" / "-"

  // Build header
  const header = [
    "NAME".padEnd(nameWidth),
    "IMAGE".padEnd(imageWidth),
    "RUNNER".padEnd(runnerWidth),
    "LOCAL".padEnd(localWidth),
  ].join("  ");

  // Build rows
  const rows = data.map((d) =>
    [
      d.name.padEnd(nameWidth),
      d.image.padEnd(imageWidth),
      d.runner.padEnd(runnerWidth),
      (d.local ? "✓" : "-").padEnd(localWidth),
    ].join("  ")
  );

  return [header, ...rows].join("\n");
}

/**
 * List all available agent profiles
 */
export async function listAgents(options: ListAgentsOptions): Promise<void> {
  const logger = getLogger();
  const cwd = process.cwd();

  try {
    // Load all profiles
    const profiles = loadAllProfiles();

    if (profiles.size === 0) {
      if (options.json) {
        logRaw(JSON.stringify([], null, 2));
      } else {
        logRaw("No agent profiles found. Run 'heretic agents add <name>' to create one.");
      }
      return;
    }

    // Discover which profiles have local overrides
    const localProfileNames = new Set(listLocalConfigs(cwd));

    // Build list of agent data
    const data: AgentListItem[] = [];

    for (const [name, profile] of profiles) {
      data.push({
        name,
        image: profile.image,
        runner: profile.runner || "docker",
        local: localProfileNames.has(name),
      });
    }

    // Sort by name
    data.sort((a, b) => a.name.localeCompare(b.name));

    // Output
    if (options.json) {
      logRaw(JSON.stringify(data, null, 2));
    } else {
      const table = formatTable(data);
      logRaw(table);
    }
  } catch (error) {
    logger.error({ error }, "Failed to list agents");
    process.exit(1);
  }
}

interface AddAgentOptions {
  force?: boolean;
}

/**
 * Add a new agent profile via interactive wizard
 */
export async function addAgent(name: string, options: AddAgentOptions): Promise<void> {
  const logger = getLogger();

  try {
    // Check if profile already exists
    const profilePath = join(getProfilesDir(), `${name}.yaml`);
    if (existsSync(profilePath) && !options.force) {
      logger.error(`Profile '${name}' already exists. Use --force to overwrite.`);
      process.exit(1);
    }

    if (existsSync(profilePath) && options.force) {
      logger.info(`Overwriting existing profile '${name}'...`);
    }

    // Start interactive wizard
    logRaw(`\nCreating agent profile: ${name}\n`);

    // Required: Image
    const imageAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "image",
        message: "Docker image:",
        validate: (input: string): string | boolean => {
          if (!input || !input.trim()) {
            return "Docker image is required";
          }
          return true;
        },
      },
    ]);

    // Required: Runner type
    const selectedRunner = await promptList("Runner type:", [
      { name: "Docker", value: "docker" },
      { name: "Docker Compose", value: "compose" },
      { name: "Custom", value: "custom" },
    ]);

    // Optional: Volumes (repeating)
    const volumes: VolumeMount[] = [];
    let addMoreVolumes = true;

    const firstVolumePrompt = await inquirer.prompt([
      {
        type: "confirm",
        name: "addVolume",
        message: "Add volume mount?",
        default: true,
      },
    ]);

    addMoreVolumes = firstVolumePrompt.addVolume;

    while (addMoreVolumes) {
      const volumeAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "source",
          message: "  Source path (host):",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Source path is required";
            }
            return true;
          },
        },
        {
          type: "input",
          name: "target",
          message: "  Target path (container):",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Target path is required";
            }
            return true;
          },
        },
        {
          type: "confirm",
          name: "readonly",
          message: "  Read-only?",
          default: false,
        },
      ]);

      volumes.push({
        source: volumeAnswer.source,
        target: volumeAnswer.target,
        readonly: volumeAnswer.readonly,
      });

      const continueAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "addAnother",
          message: "Add another volume mount?",
          default: false,
        },
      ]);

      addMoreVolumes = continueAnswer.addAnother;
    }

    // Optional: Environment variables (repeating)
    const env: Record<string, string> = {};
    let addMoreEnv = true;

    const firstEnvPrompt = await inquirer.prompt([
      {
        type: "confirm",
        name: "addEnv",
        message: "Add environment variable?",
        default: true,
      },
    ]);

    addMoreEnv = firstEnvPrompt.addEnv;

    while (addMoreEnv) {
      const envAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "key",
          message: "  Variable name:",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Variable name is required";
            }
            if (!/^[A-Z_][A-Z0-9_]*$/i.test(input)) {
              return "Variable name must be valid (letters, numbers, underscores)";
            }
            return true;
          },
        },
        {
          type: "input",
          name: "value",
          message: "  Variable value:",
        },
      ]);

      env[envAnswer.key] = envAnswer.value;

      const continueAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "addAnother",
          message: "Add another environment variable?",
          default: false,
        },
      ]);

      addMoreEnv = continueAnswer.addAnother;
    }

    // Optional: Working directory
    const workdirAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "workdir",
        message: "Working directory (optional, press Enter to skip):",
      },
    ]);

    // Optional: Command
    const commandAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "command",
        message: "Command (optional, space-separated, press Enter to skip):",
      },
    ]);

    // Parse command string into array
    const command = commandAnswer.command ? commandAnswer.command.trim().split(/\s+/) : undefined;

    // Interactive/TTY settings
    const ttyAnswer = await inquirer.prompt([
      {
        type: "confirm",
        name: "interactive",
        message: "Enable interactive mode (stdin)?",
        default: true,
      },
      {
        type: "confirm",
        name: "tty",
        message: "Enable TTY?",
        default: true,
      },
    ]);

    // Optional: Network mode
    const networkAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "network",
        message: "Network mode (optional, e.g., 'host', press Enter to skip):",
      },
    ]);

    // Optional: Ports (repeating)
    const ports: string[] = [];
    let addMorePorts = true;

    const firstPortPrompt = await inquirer.prompt([
      {
        type: "confirm",
        name: "addPort",
        message: "Add port mapping?",
        default: false,
      },
    ]);

    addMorePorts = firstPortPrompt.addPort;

    while (addMorePorts) {
      const portAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "port",
          message: "  Port mapping (format: host:container, e.g., 8080:80):",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Port mapping is required";
            }
            if (!/^\d+:\d+$/.test(input)) {
              return "Port mapping must be in format host:container (e.g., 8080:80)";
            }
            return true;
          },
        },
      ]);

      ports.push(portAnswer.port);

      const continueAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "addAnother",
          message: "Add another port mapping?",
          default: false,
        },
      ]);

      addMorePorts = continueAnswer.addAnother;
    }

    // Build the profile object
    const profile: AgentProfile = {
      image: imageAnswer.image,
      runner: selectedRunner,
      interactive: ttyAnswer.interactive,
      tty: ttyAnswer.tty,
    };

    // Add optional fields if provided
    if (volumes.length > 0) {
      profile.volumes = volumes;
    }

    if (Object.keys(env).length > 0) {
      profile.env = env;
    }

    if (workdirAnswer.workdir) {
      profile.workdir = workdirAnswer.workdir;
    }

    if (command && command.length > 0) {
      profile.command = command;
    }

    // Build extra if needed
    if (networkAnswer.network || ports.length > 0) {
      profile.extra = {};
      if (networkAnswer.network) {
        profile.extra.network = networkAnswer.network;
      }
      if (ports.length > 0) {
        profile.extra.ports = ports;
      }
    }

    // Show summary
    logRaw("\n=== Profile Summary ===\n");
    logRaw(`Name: ${name}`);
    logRaw(`Image: ${profile.image}`);
    logRaw(`Runner: ${profile.runner}`);

    if (profile.volumes && profile.volumes.length > 0) {
      logRaw(`\nVolumes:`);
      profile.volumes.forEach((v) => {
        const ro = v.readonly ? " (read-only)" : "";
        logRaw(`  ${v.source} → ${v.target}${ro}`);
      });
    }

    if (profile.env && Object.keys(profile.env).length > 0) {
      logRaw(`\nEnvironment:`);
      Object.entries(profile.env).forEach(([key, value]) => {
        logRaw(`  ${key}=${value}`);
      });
    }

    if (profile.workdir) {
      logRaw(`\nWorking directory: ${profile.workdir}`);
    }

    if (profile.command) {
      logRaw(
        `\nCommand: ${Array.isArray(profile.command) ? profile.command.join(" ") : profile.command}`
      );
    }

    logRaw(`\nInteractive: ${profile.interactive ? "yes" : "no"}`);
    logRaw(`TTY: ${profile.tty ? "yes" : "no"}`);

    if (profile.extra?.network) {
      logRaw(`\nNetwork: ${profile.extra.network}`);
    }

    if (profile.extra?.ports && Array.isArray(profile.extra.ports)) {
      logRaw(`\nPorts:`);
      (profile.extra.ports as string[]).forEach((p) => {
        logRaw(`  ${p}`);
      });
    }

    // Confirm save
    const confirmAnswer = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "\nSave this profile?",
        default: true,
      },
    ]);

    if (!confirmAnswer.confirm) {
      logRaw("Profile not saved.");
      return;
    }

    // Save profile
    saveProfile(name, profile);
    logRaw(`\n✓ Profile '${name}' saved to ${profilePath}`);
  } catch (error) {
    logger.error({ error }, "Failed to create agent profile");
    process.exit(1);
  }
}

interface EditAgentOptions {
  editor?: boolean;
}

/**
 * Show a diff summary between two profiles
 */
function showProfileDiff(oldProfile: AgentProfile, newProfile: AgentProfile): void {
  const changes: string[] = [];

  // Compare simple fields
  if (oldProfile.image !== newProfile.image) {
    changes.push(`  Image: ${oldProfile.image} → ${newProfile.image}`);
  }
  if (oldProfile.runner !== newProfile.runner) {
    changes.push(`  Runner: ${oldProfile.runner} → ${newProfile.runner}`);
  }
  if (oldProfile.workdir !== newProfile.workdir) {
    changes.push(
      `  Working directory: ${oldProfile.workdir || "(none)"} → ${newProfile.workdir || "(none)"}`
    );
  }
  if (JSON.stringify(oldProfile.command) !== JSON.stringify(newProfile.command)) {
    const oldCmd = Array.isArray(oldProfile.command)
      ? oldProfile.command.join(" ")
      : oldProfile.command || "(none)";
    const newCmd = Array.isArray(newProfile.command)
      ? newProfile.command.join(" ")
      : newProfile.command || "(none)";
    changes.push(`  Command: ${oldCmd} → ${newCmd}`);
  }
  if (oldProfile.interactive !== newProfile.interactive) {
    changes.push(`  Interactive: ${oldProfile.interactive} → ${newProfile.interactive}`);
  }
  if (oldProfile.tty !== newProfile.tty) {
    changes.push(`  TTY: ${oldProfile.tty} → ${newProfile.tty}`);
  }

  // Compare volumes
  const oldVolumes = JSON.stringify(oldProfile.volumes || []);
  const newVolumes = JSON.stringify(newProfile.volumes || []);
  if (oldVolumes !== newVolumes) {
    changes.push(
      `  Volumes: ${(oldProfile.volumes || []).length} → ${(newProfile.volumes || []).length} mount(s)`
    );
  }

  // Compare env
  const oldEnv = JSON.stringify(oldProfile.env || {});
  const newEnv = JSON.stringify(newProfile.env || {});
  if (oldEnv !== newEnv) {
    changes.push(
      `  Environment: ${Object.keys(oldProfile.env || {}).length} → ${Object.keys(newProfile.env || {}).length} variable(s)`
    );
  }

  // Compare extra options
  const oldExtra = JSON.stringify(oldProfile.extra || {});
  const newExtra = JSON.stringify(newProfile.extra || {});
  if (oldExtra !== newExtra) {
    changes.push(`  Extra options: modified`);
  }

  if (changes.length === 0) {
    logRaw("\nNo changes detected.");
  } else {
    logRaw("\n=== Changes ===");
    changes.forEach((change) => logRaw(change));
  }
}

/**
 * Edit profile using interactive prompts with pre-filled values
 */
async function editProfileInteractive(
  name: string,
  currentProfile: AgentProfile
): Promise<AgentProfile> {
  logRaw(`\nEditing agent profile: ${name}\n`);

  // Image
  const imageAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "image",
      message: "Docker image:",
      default: currentProfile.image,
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "Docker image is required";
        }
        return true;
      },
    },
  ]);

  // Runner type
  const selectedRunner = await promptList("Runner type:", [
    { name: "Docker", value: "docker" },
    { name: "Docker Compose", value: "compose" },
    { name: "Custom", value: "custom" },
  ]);

  // Volumes
  const volumes: VolumeMount[] = [];
  const editVolumesAction = await promptList(
    `Volume mounts (currently ${(currentProfile.volumes || []).length}):`,
    [
      { name: "Keep existing", value: "keep" },
      { name: "Edit volumes", value: "edit" },
    ]
  );

  if (editVolumesAction === "keep" && currentProfile.volumes) {
    volumes.push(...currentProfile.volumes);
  } else if (editVolumesAction === "edit") {
    let addMoreVolumes = true;

    const firstVolumePrompt = await inquirer.prompt([
      {
        type: "confirm",
        name: "addVolume",
        message: "Add volume mount?",
        default: (currentProfile.volumes || []).length > 0,
      },
    ]);

    addMoreVolumes = firstVolumePrompt.addVolume;

    while (addMoreVolumes) {
      const volumeAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "source",
          message: "  Source path (host):",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Source path is required";
            }
            return true;
          },
        },
        {
          type: "input",
          name: "target",
          message: "  Target path (container):",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Target path is required";
            }
            return true;
          },
        },
        {
          type: "confirm",
          name: "readonly",
          message: "  Read-only?",
          default: false,
        },
      ]);

      volumes.push({
        source: volumeAnswer.source,
        target: volumeAnswer.target,
        readonly: volumeAnswer.readonly,
      });

      const continueAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "addAnother",
          message: "Add another volume mount?",
          default: false,
        },
      ]);

      addMoreVolumes = continueAnswer.addAnother;
    }
  }

  // Environment variables
  const env: Record<string, string> = {};
  const editEnvAction = await promptList(
    `Environment variables (currently ${Object.keys(currentProfile.env || {}).length}):`,
    [
      { name: "Keep existing", value: "keep" },
      { name: "Edit variables", value: "edit" },
    ]
  );

  if (editEnvAction === "keep" && currentProfile.env) {
    Object.assign(env, currentProfile.env);
  } else if (editEnvAction === "edit") {
    let addMoreEnv = true;

    const firstEnvPrompt = await inquirer.prompt([
      {
        type: "confirm",
        name: "addEnv",
        message: "Add environment variable?",
        default: Object.keys(currentProfile.env || {}).length > 0,
      },
    ]);

    addMoreEnv = firstEnvPrompt.addEnv;

    while (addMoreEnv) {
      const envAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "key",
          message: "  Variable name:",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Variable name is required";
            }
            if (!/^[A-Z_][A-Z0-9_]*$/i.test(input)) {
              return "Variable name must be valid (letters, numbers, underscores)";
            }
            return true;
          },
        },
        {
          type: "input",
          name: "value",
          message: "  Variable value:",
        },
      ]);

      env[envAnswer.key] = envAnswer.value;

      const continueAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "addAnother",
          message: "Add another environment variable?",
          default: false,
        },
      ]);

      addMoreEnv = continueAnswer.addAnother;
    }
  }

  // Working directory
  const workdirAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "workdir",
      message: "Working directory (optional, press Enter to skip):",
      default: currentProfile.workdir || "",
    },
  ]);

  // Command
  const currentCommand = Array.isArray(currentProfile.command)
    ? currentProfile.command.join(" ")
    : currentProfile.command || "";

  const commandAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "command",
      message: "Command (optional, space-separated, press Enter to skip):",
      default: currentCommand,
    },
  ]);

  const command = commandAnswer.command ? commandAnswer.command.trim().split(/\s+/) : undefined;

  // Interactive/TTY settings
  const ttyAnswer = await inquirer.prompt([
    {
      type: "confirm",
      name: "interactive",
      message: "Enable interactive mode (stdin)?",
      default: currentProfile.interactive !== false,
    },
    {
      type: "confirm",
      name: "tty",
      message: "Enable TTY?",
      default: currentProfile.tty !== false,
    },
  ]);

  // Network mode
  const networkAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "network",
      message: "Network mode (optional, e.g., 'host', press Enter to skip):",
      default: currentProfile.extra?.network || "",
    },
  ]);

  // Ports
  const ports: string[] = [];
  const editPortsAction = await promptList(
    `Port mappings (currently ${((currentProfile.extra?.ports as string[]) || []).length}):`,
    [
      { name: "Keep existing", value: "keep" },
      { name: "Edit ports", value: "edit" },
    ]
  );

  if (editPortsAction === "keep" && currentProfile.extra?.ports) {
    ports.push(...(currentProfile.extra.ports as string[]));
  } else if (editPortsAction === "edit") {
    let addMorePorts = true;

    const firstPortPrompt = await inquirer.prompt([
      {
        type: "confirm",
        name: "addPort",
        message: "Add port mapping?",
        default: ((currentProfile.extra?.ports as string[]) || []).length > 0,
      },
    ]);

    addMorePorts = firstPortPrompt.addPort;

    while (addMorePorts) {
      const portAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "port",
          message: "  Port mapping (format: host:container, e.g., 8080:80):",
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Port mapping is required";
            }
            if (!/^\d+:\d+$/.test(input)) {
              return "Port mapping must be in format host:container (e.g., 8080:80)";
            }
            return true;
          },
        },
      ]);

      ports.push(portAnswer.port);

      const continueAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "addAnother",
          message: "Add another port mapping?",
          default: false,
        },
      ]);

      addMorePorts = continueAnswer.addAnother;
    }
  }

  // Build the profile object
  const profile: AgentProfile = {
    image: imageAnswer.image,
    runner: selectedRunner,
    interactive: ttyAnswer.interactive,
    tty: ttyAnswer.tty,
  };

  // Add optional fields if provided
  if (volumes.length > 0) {
    profile.volumes = volumes;
  }

  if (Object.keys(env).length > 0) {
    profile.env = env;
  }

  if (workdirAnswer.workdir) {
    profile.workdir = workdirAnswer.workdir;
  }

  if (command && command.length > 0) {
    profile.command = command;
  }

  // Build extra if needed
  if (networkAnswer.network || ports.length > 0) {
    profile.extra = {};
    if (networkAnswer.network) {
      profile.extra.network = networkAnswer.network;
    }
    if (ports.length > 0) {
      profile.extra.ports = ports;
    }
  }

  // Preserve other fields from current profile
  if (currentProfile.name) {
    profile.name = currentProfile.name;
  }
  if (currentProfile.description) {
    profile.description = currentProfile.description;
  }
  if (currentProfile.enabled !== undefined) {
    profile.enabled = currentProfile.enabled;
  }

  return profile;
}

/**
 * Edit profile using system editor
 */
async function editProfileWithEditor(
  name: string,
  currentProfile: AgentProfile
): Promise<AgentProfile | null> {
  const logger = getLogger();
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const tempFile = join(tmpdir(), `heretic-agent-${name}-${Date.now()}.yaml`);

  try {
    // Write current profile to temp file
    const yamlContent = stringifyYaml(currentProfile);
    writeFileSync(tempFile, yamlContent, "utf-8");
    logger.debug({ tempFile }, "Wrote profile to temp file");

    // Open in editor
    logRaw(`\nOpening profile in ${editor}...`);
    logRaw(`Temp file: ${tempFile}\n`);

    // Detect if editor is a GUI app that forks to background.
    // Terminal editors (vi, vim, nvim, nano, emacs -nw, micro, helix) block until closed.
    // GUI editors (code, geany, subl, kate, etc.) may fork and return immediately.
    const editorBasename = editor.split("/").pop()?.toLowerCase() || "";
    const terminalEditors = [
      "vi",
      "vim",
      "nvim",
      "nano",
      "pico",
      "emacs",
      "micro",
      "hx",
      "helix",
      "ed",
      "joe",
      "jed",
      "ne",
    ];
    const isTerminalEditor = terminalEditors.includes(editorBasename);

    let proc;
    try {
      proc = Bun.spawn([editor, tempFile], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (spawnError) {
      logger.error(
        `Failed to launch editor '${editor}': ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
      );
      logRaw(
        `Make sure '${editor}' is installed and in your PATH, or set the EDITOR environment variable.`
      );
      return null;
    }

    await proc.exited;

    if (proc.exitCode !== 0) {
      // Some GUI editors return non-zero when forking; only treat as error for terminal editors
      if (isTerminalEditor) {
        logger.error({ exitCode: proc.exitCode }, "Editor exited with error");
        return null;
      }
      logger.debug(
        { exitCode: proc.exitCode },
        "Editor returned non-zero (may be expected for GUI editors)"
      );
    }

    // For GUI editors, the process may have forked and exited immediately.
    // Wait for the user to confirm they are done editing.
    if (!isTerminalEditor) {
      await inquirer.prompt([
        {
          type: "confirm",
          name: "done",
          message: "Press Enter when you are done editing the file",
          default: true,
        },
      ]);
    }

    // Read back the file
    const editedContent = readFileSync(tempFile, "utf-8");

    // Parse YAML
    let editedProfile: AgentProfile;
    try {
      editedProfile = parseYaml<AgentProfile>(editedContent);
    } catch (error) {
      logRaw(`\n❌ Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);

      const retryAction = await promptList("What would you like to do?", [
        { name: "Re-edit", value: "retry" },
        { name: "Discard changes", value: "discard" },
      ]);

      if (retryAction === "retry") {
        // Recursive call to retry
        return await editProfileWithEditor(name, currentProfile);
      } else {
        return null;
      }
    }

    // Validate the profile
    const errors = validateProfile(editedProfile);
    if (errors.length > 0) {
      logRaw(`\n❌ Invalid profile:\n`);
      errors.forEach((err) => logRaw(`  - ${err}`));

      const retryAction = await promptList("What would you like to do?", [
        { name: "Re-edit", value: "retry" },
        { name: "Discard changes", value: "discard" },
      ]);

      if (retryAction === "retry") {
        // Write the edited (but invalid) content back to temp file for retry
        writeFileSync(tempFile, editedContent, "utf-8");
        return await editProfileWithEditor(name, currentProfile);
      } else {
        return null;
      }
    }

    return editedProfile;
  } catch (error) {
    logger.error(
      `Failed to edit with editor '${editor}': ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    // Clean up temp file
    try {
      if (existsSync(tempFile)) {
        unlinkSync(tempFile);
        logger.debug({ tempFile }, "Cleaned up temp file");
      }
    } catch (cleanupError) {
      logger.warn({ cleanupError, tempFile }, "Failed to clean up temp file");
    }
  }
}

/**
 * Edit an existing agent profile
 */
export async function editAgent(name: string, options: EditAgentOptions): Promise<void> {
  const logger = getLogger();

  try {
    // Load existing profile
    const currentProfile = loadProfile(name);
    logger.debug({ name, currentProfile }, "Loaded current profile");

    let newProfile: AgentProfile | null;

    if (options.editor) {
      // Editor mode
      newProfile = await editProfileWithEditor(name, currentProfile);

      if (!newProfile) {
        logRaw("\nProfile not saved.");
        return;
      }
    } else {
      // Interactive mode
      newProfile = await editProfileInteractive(name, currentProfile);
    }

    // Show diff
    showProfileDiff(currentProfile, newProfile);

    // Confirm save
    const confirmAnswer = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "\nSave changes?",
        default: true,
      },
    ]);

    if (!confirmAnswer.confirm) {
      logRaw("Changes not saved.");
      return;
    }

    // Save profile
    saveProfile(name, newProfile);
    const profilePath = join(getProfilesDir(), `${name}.yaml`);
    logRaw(`\n✓ Profile '${name}' updated at ${profilePath}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Profile not found")) {
      logger.error(
        `Profile '${name}' not found. Use 'heretic agents list' to see available profiles.`
      );
    } else {
      logger.error(
        `Failed to edit agent profile: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    process.exit(1);
  }
}

interface ShowAgentOptions {
  resolved?: boolean;
  reveal?: boolean;
}

/**
 * Helper function to mask sensitive environment variables
 */
function maskSensitiveEnv(
  env: Record<string, string> | undefined,
  reveal: boolean
): Record<string, string> | undefined {
  if (!env || reveal) {
    return env;
  }

  const sensitiveKeys = ["key", "token", "secret", "password"];
  const masked: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const keyLower = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((pattern) => keyLower.includes(pattern));

    if (isSensitive) {
      masked[key] = maskToken(value);
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

/**
 * Show an agent profile configuration
 */
export async function showAgent(name: string, options: ShowAgentOptions): Promise<void> {
  const logger = getLogger();

  try {
    // Load the profile - this will throw if not found
    const profile = loadProfile(name);
    logger.debug({ name }, "Loaded profile");

    let outputData: unknown;

    if (options.resolved) {
      // Get fully resolved config with interpolated values
      const resolved = resolveConfig({
        profileName: name,
        projectDir: process.cwd(),
      });

      // Mask sensitive env vars unless --reveal is set
      const maskedEnv = maskSensitiveEnv(resolved.env, options.reveal || false);

      // Build output object with resolved values
      outputData = {
        image: resolved.image,
        runner: resolved.runner,
        volumes: resolved.volumes,
        env: maskedEnv,
        workdir: resolved.workdir || undefined,
        command: resolved.command.length > 0 ? resolved.command : undefined,
        interactive: resolved.interactive,
        tty: resolved.tty,
        extra: Object.keys(resolved.extra).length > 0 ? resolved.extra : undefined,
      };
    } else {
      // Output raw profile
      const maskedEnv = maskSensitiveEnv(profile.env, options.reveal || false);

      outputData = {
        ...profile,
        env: maskedEnv,
      };
    }

    // Remove undefined values for cleaner YAML output
    const cleanData = JSON.parse(JSON.stringify(outputData));

    // Convert to YAML and output
    const yamlOutput = stringifyYaml(cleanData);
    logRaw(yamlOutput);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Profile not found")) {
      logger.error(
        `Profile '${name}' not found. Use 'heretic agents list' to see available profiles.`
      );
    } else {
      logger.error({ error }, "Failed to show agent profile");
    }
    process.exit(1);
  }
}

/**
 * Validate one or all agent profiles
 */
export async function validateAgents(name?: string): Promise<void> {
  const logger = getLogger();
  let hasErrors = false;

  try {
    if (name) {
      // Validate single profile
      const profilePath = join(getProfilesDir(), `${name}.yaml`);

      if (!existsSync(profilePath)) {
        logger.error(`Profile '${name}' not found`);
        process.exit(1);
      }

      logRaw(`Validating profile "${name}"...`);

      // Try to parse YAML first
      let profile: AgentProfile;
      try {
        profile = parseYaml<AgentProfile>(readFileSync(profilePath, "utf-8"));
      } catch (error) {
        logRaw(`  [fail] YAML syntax: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }

      logRaw("  [pass] YAML syntax");

      // Run detailed validation
      const result = validateProfileDetailed(profile);

      // Check required fields
      if (result.errors.some((e) => e.includes("missing required field"))) {
        logRaw("  [fail] Required fields");
      } else {
        logRaw("  [pass] Required fields");
      }

      // Report all errors
      for (const error of result.errors) {
        // Skip generic required field errors (already reported above)
        if (!error.includes("missing required field")) {
          logRaw(`  [fail] ${error}`);
          hasErrors = true;
        } else {
          hasErrors = true;
        }
      }

      // Report all warnings
      for (const warning of result.warnings) {
        logRaw(`  [warn] ${warning}`);
      }

      // If no errors beyond initial checks, mark as passed
      if (result.errors.length === 0 && result.warnings.length === 0) {
        logRaw("  [pass] All validation checks passed");
      }
    } else {
      // Validate all profiles
      const profileNames = listProfiles();

      if (profileNames.length === 0) {
        logRaw("No agent profiles found. Run 'heretic agents add <name>' to create one.");
        return;
      }

      for (const profileName of profileNames) {
        const profilePath = join(getProfilesDir(), `${profileName}.yaml`);
        logRaw(`\nValidating profile "${profileName}"...`);

        // Try to parse YAML first
        let profile: AgentProfile;
        try {
          profile = parseYaml<AgentProfile>(readFileSync(profilePath, "utf-8"));
        } catch (error) {
          logRaw(`  [fail] YAML syntax: ${error instanceof Error ? error.message : String(error)}`);
          hasErrors = true;
          continue;
        }

        logRaw("  [pass] YAML syntax");

        // Run detailed validation
        const result = validateProfileDetailed(profile);

        // Check required fields
        if (result.errors.some((e) => e.includes("missing required field"))) {
          logRaw("  [fail] Required fields");
        } else {
          logRaw("  [pass] Required fields");
        }

        // Report all errors
        for (const error of result.errors) {
          // Skip generic required field errors (already reported above)
          if (!error.includes("missing required field")) {
            logRaw(`  [fail] ${error}`);
            hasErrors = true;
          } else {
            hasErrors = true;
          }
        }

        // Report all warnings
        for (const warning of result.warnings) {
          logRaw(`  [warn] ${warning}`);
        }

        // If no errors beyond initial checks, mark as passed
        if (result.errors.length === 0 && result.warnings.length === 0) {
          logRaw("  [pass] All validation checks passed");
        }
      }
    }

    if (hasErrors) {
      process.exit(1);
    }
  } catch (error) {
    logger.error({ error }, "Failed to validate agent profiles");
    process.exit(1);
  }
}

interface McpAgentOptions {
  local?: boolean;
  file?: string;
}

/**
 * Add or update MCP servers from JSON (paste or file)
 */
export async function mcpAgent(profileName: string, options: McpAgentOptions): Promise<void> {
  const logger = getLogger();

  try {
    // Verify the profile exists (needed for both global and local modes)
    const profilePath = join(getProfilesDir(), `${profileName}.yaml`);
    if (!existsSync(profilePath)) {
      logger.error(
        `Profile '${profileName}' not found. Use 'heretic agents list' to see available profiles.`
      );
      process.exit(1);
    }

    // Read input JSON
    let parsed: unknown;

    if (options.file) {
      // Read from file
      const raw = readFileSync(options.file, "utf-8");
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logger.error(
          `Failed to parse JSON from ${options.file}: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    } else {
      // Use inquirer.editor() to open $EDITOR for multiline paste
      const editorAnswer = await inquirer.prompt([
        {
          type: "editor",
          name: "json",
          message: "Paste MCP server JSON (opens editor):",
        },
      ]);

      const raw = editorAnswer.json.trim();
      if (!raw) {
        logger.error("No input provided");
        process.exit(1);
      }

      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logger.error(
          `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    }

    // Parse MCP servers from JSON
    const newServers = parseMcpJson(parsed, options.file || "editor input");

    if (newServers.length === 0) {
      logRaw("No MCP servers found in the input.");
      return;
    }

    // Show preview
    logRaw("\n=== MCP Servers Found ===\n");
    for (const server of newServers) {
      const argsSummary = server.args ? server.args.join(" ") : "";
      logRaw(`  ${server.name}: ${server.command} ${argsSummary}`.trimEnd());
    }

    // Confirm
    const confirmAnswer = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `\nMerge ${newServers.length} server(s) into ${options.local ? "local override" : `profile '${profileName}'`}?`,
        default: true,
      },
    ]);

    if (!confirmAnswer.confirm) {
      logRaw("Cancelled.");
      return;
    }

    if (options.local) {
      // Local override mode
      const cwd = process.cwd();
      let config;
      let existingMcp: McpServer[] = [];

      if (hasLocalConfig(cwd, profileName)) {
        config = loadLocalConfig(cwd, profileName);
        existingMcp = config.mcp || [];
      } else {
        config = { extends: profileName };
      }

      // Merge by name
      const serverMap = new Map<string, McpServer>();
      for (const s of existingMcp) serverMap.set(s.name, s);
      for (const s of newServers) serverMap.set(s.name, s);
      const merged = [...serverMap.values()];

      config.mcp = merged;
      saveLocalConfig(cwd, config, profileName);

      const added = newServers.filter((s) => !existingMcp.some((e) => e.name === s.name));
      const updated = newServers.filter((s) => existingMcp.some((e) => e.name === s.name));

      logRaw(`\n✓ Local override updated (.heretic/cli/${profileName}.yaml)`);
      if (added.length > 0) logRaw(`  Added: ${added.map((s) => s.name).join(", ")}`);
      if (updated.length > 0) logRaw(`  Updated: ${updated.map((s) => s.name).join(", ")}`);
      logRaw(`  Total MCP servers: ${merged.length}`);
    } else {
      // Global profile mode
      const profile = loadProfile(profileName);
      const existingMcp = profile.mcp || [];

      // Merge by name
      const serverMap = new Map<string, McpServer>();
      for (const s of existingMcp) serverMap.set(s.name, s);
      for (const s of newServers) serverMap.set(s.name, s);
      const merged = [...serverMap.values()];

      profile.mcp = merged;
      saveProfile(profileName, profile);

      const added = newServers.filter((s) => !existingMcp.some((e) => e.name === s.name));
      const updated = newServers.filter((s) => existingMcp.some((e) => e.name === s.name));

      logRaw(`\n✓ Profile '${profileName}' updated`);
      if (added.length > 0) logRaw(`  Added: ${added.map((s) => s.name).join(", ")}`);
      if (updated.length > 0) logRaw(`  Updated: ${updated.map((s) => s.name).join(", ")}`);
      logRaw(`  Total MCP servers: ${merged.length}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Profile not found")) {
      logger.error(
        `Profile '${profileName}' not found. Use 'heretic agents list' to see available profiles.`
      );
    } else {
      logger.error(
        `Failed to update MCP servers: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    process.exit(1);
  }
}

interface DeleteAgentOptions {
  force?: boolean;
}

/**
 * Find all running/stopped containers for a given agent profile name
 */
async function findContainersForAgent(
  agentName: string
): Promise<import("dockerode").ContainerInfo[]> {
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return [];
  }

  const docker = getDockerClient();
  return listContainers(docker, {
    all: true,
    filters: JSON.stringify({
      label: ["heretic.managed=true", `heretic.agent=${agentName}`],
    }),
  });
}

/**
 * Delete an agent profile and its associated files
 */
export async function deleteAgent(name: string, options: DeleteAgentOptions): Promise<void> {
  const logger = getLogger();

  try {
    const profilePath = join(getProfilesDir(), `${name}.yaml`);

    if (!existsSync(profilePath)) {
      logger.error(
        `Profile '${name}' not found. Use 'heretic agents list' to see available profiles.`
      );
      process.exit(1);
    }

    // Find running containers for this agent
    const containers = await findContainersForAgent(name);

    // Collect associated files
    const hereticDir = getHereticDir();
    const associatedFiles: { path: string; label: string }[] = [];

    // Secret scripts (sh and cmd variants)
    const secretSh = join(hereticDir, `get-${name}-key.sh`);
    const secretCmd = join(hereticDir, `get-${name}-key.cmd`);
    if (existsSync(secretSh)) {
      associatedFiles.push({ path: secretSh, label: "secret script" });
    }
    if (existsSync(secretCmd)) {
      associatedFiles.push({ path: secretCmd, label: "secret script" });
    }

    // Claude settings file
    const settingsFile = join(hereticDir, `${name}-settings.json`);
    if (existsSync(settingsFile)) {
      associatedFiles.push({ path: settingsFile, label: "Claude settings" });
    }

    // Show what will be deleted
    if (containers.length > 0) {
      logRaw(`\nRunning containers (${containers.length}):`);
      for (const c of containers) {
        const cName = c.Names[0]?.replace(/^\//, "") || c.Id.substring(0, 12);
        const session = c.Labels?.["heretic.session"] || "-";
        logRaw(`  ${cName} (session: ${session}, state: ${c.State})`);
      }
    }
    logRaw(`\nProfile: ${profilePath}`);
    if (associatedFiles.length > 0) {
      logRaw("Associated files:");
      for (const file of associatedFiles) {
        logRaw(`  ${file.label}: ${file.path}`);
      }
    }

    // Confirm unless --force
    if (!options.force) {
      const message =
        containers.length > 0
          ? `Stop ${containers.length} container(s), delete agent '${name}' and ${associatedFiles.length} associated file(s)?`
          : `Delete agent '${name}' and ${associatedFiles.length} associated file(s)?`;

      const confirmAnswer = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message,
          default: false,
        },
      ]);

      if (!confirmAnswer.confirm) {
        logRaw("Cancelled.");
        return;
      }
    }

    // Stop and remove all containers for this agent
    if (containers.length > 0) {
      const docker = getDockerClient();
      for (const c of containers) {
        const cName = c.Names[0]?.replace(/^\//, "") || c.Id.substring(0, 12);
        try {
          if (c.State === "running") {
            await stopContainer(c.Id, { t: 10 }, docker);
            logRaw(`Stopped ${cName}`);
          }
          await removeContainer(c.Id, {}, docker);
          logRaw(`Removed ${cName}`);
        } catch (error) {
          logger.warn(
            { error, container: cName },
            `Failed to stop/remove container ${cName}, continuing...`
          );
        }
      }
    }

    // Delete profile
    unlinkSync(profilePath);
    logRaw(`Deleted profile: ${profilePath}`);

    // Delete associated files
    for (const file of associatedFiles) {
      unlinkSync(file.path);
      logRaw(`Deleted ${file.label}: ${file.path}`);
    }

    logRaw(`\nAgent '${name}' deleted.`);
  } catch (error) {
    logger.error(
      `Failed to delete agent profile: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

/**
 * Create the agents command group with subcommands
 */
export function createAgentsCommand(): Command {
  const agents = new Command("agents");
  agents.description("Manage agent profiles");

  // List subcommand
  const listCmd = new Command("list");
  listCmd
    .description("List all available agent profiles")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      await listAgents({ json: options.json });
    });

  agents.addCommand(listCmd);

  // Add subcommand
  const addCmd = new Command("add");
  addCmd
    .description("Create a new agent profile")
    .argument("<name>", "Profile name")
    .option("--force", "Overwrite existing profile")
    .action(async (name: string, options) => {
      await addAgent(name, { force: options.force });
    });

  agents.addCommand(addCmd);

  // Delete subcommand
  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete an agent profile and associated files")
    .argument("<name>", "Profile name")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (name: string, options) => {
      await deleteAgent(name, { force: options.force });
    });

  agents.addCommand(deleteCmd);

  // Edit subcommand
  const editCmd = new Command("edit");
  editCmd
    .description("Edit an existing agent profile")
    .argument("<name>", "Profile name")
    .option("--editor", "Open in system editor instead of interactive prompts")
    .action(async (name: string, options) => {
      await editAgent(name, { editor: options.editor });
    });

  agents.addCommand(editCmd);

  // Show subcommand
  const showCmd = new Command("show");
  showCmd
    .description("Display a profile's full configuration")
    .argument("<name>", "Profile name")
    .option("--resolved", "Show fully resolved config with interpolated values")
    .option("--reveal", "Show actual values for sensitive environment variables")
    .action(async (name: string, options) => {
      await showAgent(name, { resolved: options.resolved, reveal: options.reveal });
    });

  agents.addCommand(showCmd);

  // Validate subcommand
  const validateCmd = new Command("validate");
  validateCmd
    .description("Validate profile syntax and references")
    .argument("[name]", "Profile name (optional - validates all if omitted)")
    .action(async (name?: string) => {
      await validateAgents(name);
    });

  agents.addCommand(validateCmd);

  // MCP subcommand
  const mcpCmd = new Command("mcp");
  mcpCmd
    .description("Add or update MCP servers from JSON (paste or file)")
    .argument("<name>", "Profile name")
    .option(
      "--local",
      "Apply to local override (.heretic/cli/<name>.yaml) instead of global profile"
    )
    .option("--file <path>", "Read MCP JSON from file instead of stdin")
    .action(async (name: string, options) => {
      await mcpAgent(name, { local: options.local, file: options.file });
    });

  agents.addCommand(mcpCmd);

  return agents;
}
