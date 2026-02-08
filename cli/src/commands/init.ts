import inquirer from "inquirer";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { getLogger } from "../logger";
import {
  loadSettings,
  saveSettings,
  maskToken,
  getHereticDir,
  resolveToken,
} from "../utils/settings";
import {
  saveProfile,
  listProfiles,
  loadProfile,
  ensureProfilesDir,
  getProfilesDir,
} from "../utils/profile-loader";
import { promptList } from "../utils/prompt";
import type { HereticSettings } from "../types";
import { agentTypeFromProvider } from "../types/agent-profile";
import type { AgentProfile } from "../types/agent-profile";

/**
 * Third-party provider preset type
 */
type ThirdPartyPreset = "zai" | "kimi" | "custom";

/**
 * Preset defaults for third-party providers
 */
const THIRDPARTY_PRESET_DEFAULTS: Record<
  ThirdPartyPreset,
  {
    url: string;
    model: string;
    defaultName: string;
    defaultEnvVars: Record<string, string>;
  }
> = {
  zai: {
    url: "https://api.z.ai/api/anthropic",
    model: "glm-4.7",
    defaultName: "claude-zai",
    defaultEnvVars: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      API_TIMEOUT_MS: "600000",
    },
  },
  kimi: {
    url: "https://api.moonshot.ai/anthropic",
    model: "kimi-k2.5",
    defaultName: "claude-kimi",
    defaultEnvVars: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      API_TIMEOUT_MS: "600000",
    },
  },
  custom: {
    url: "",
    model: "",
    defaultName: "claude-thirdparty",
    defaultEnvVars: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      API_TIMEOUT_MS: "600000",
    },
  },
};

/**
 * Anthropic token type discriminator
 * - "api" → ANTHROPIC_AUTH_TOKEN + ANTHROPIC_AUTH_KEY (API billing)
 * - "oauth" → CLAUDE_CODE_OAUTH_TOKEN (subscription/OAuth token)
 */
type AnthropicTokenType = "api" | "oauth";

interface AgentInput {
  name: string;
  type: "anthropic" | "thirdparty" | "copilot";
  dockerImage: string;
  token: string;
  apiUrl?: string; // Only for third-party
  settingsPath?: string; // Optional path to existing settings.json
  preset?: ThirdPartyPreset; // Only for third-party
  modelConfigMethod?: "env" | "settings"; // Only for third-party
  model?: string; // Only for third-party when modelConfigMethod is "env"
  customEnvVars?: Record<string, string>; // Custom env vars for third-party
  anthropicTokenType?: AnthropicTokenType; // Only for anthropic
}

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Create a secrets script for a token (cross-platform).
 *
 * Windows: creates a .cmd script (runs via cmd.exe).
 * Unix:    creates a .sh script (runs via bash/sh).
 *
 * Users can replace these with .ps1 scripts or 1Password/Keychain calls later.
 */
function createSecretsScript(hereticDir: string, scriptName: string, token: string): string {
  if (isWindows()) {
    const scriptPath = join(hereticDir, `get-${scriptName}-key.cmd`);
    // Use set /p with nul to echo without trailing newline/spaces
    const scriptContent =
      `@echo off\r\n` +
      `REM Secret script for ${scriptName}\r\n` +
      `REM TODO: Replace with secure method:\r\n` +
      `REM   - 1Password CLI: op read "op://vault/${scriptName}/key"\r\n` +
      `REM   - PowerShell: create a .ps1 script instead\r\n` +
      `echo|set /p="${token}"\r\n`;
    writeFileSync(scriptPath, scriptContent);
    return scriptPath;
  } else {
    const scriptPath = join(hereticDir, `get-${scriptName}-key.sh`);
    const scriptContent = `#!/bin/bash
# Secret script for ${scriptName}
# TODO: Replace with secure method:
#   - 1Password: op read 'op://vault/${scriptName}/key'
#   - macOS Keychain: security find-generic-password -s '${scriptName}' -w
#   - pass: pass show ${scriptName}
echo "${token}"
`;
    writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    return scriptPath;
  }
}

/**
 * Model environment variables for third-party providers
 * When using "env" model config method, these are set to the selected model
 */
const MODEL_ENV_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/**
 * Create Claude settings.json file for the agent
 * If sourceSettingsPath provided, copies and merges with defaults
 * For third-party agents using "settings" model config, adds model env vars
 */
function createClaudeSettings(
  hereticDir: string,
  agentName: string,
  agentType: "anthropic" | "thirdparty" | "copilot",
  sourceSettingsPath?: string,
  modelConfigMethod?: "env" | "settings",
  model?: string
): string {
  const logger = getLogger();
  const destPath = join(hereticDir, `${agentName}-settings.json`);

  let settings: Record<string, unknown>;

  // Load from source or create base settings
  if (sourceSettingsPath) {
    const expandedSource = sourceSettingsPath.startsWith("~")
      ? sourceSettingsPath.replace("~", process.env.HOME || "")
      : sourceSettingsPath;
    const content = readFileSync(expandedSource, "utf-8");
    settings = JSON.parse(content) as Record<string, unknown>;
    logger.info(`  Loaded settings from: ${expandedSource}`);
  } else {
    // Base settings for all agents
    settings = {
      permissions: {
        allow: ["Read", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "mcp__*"],
      },
      model: "opus",
    };
  }

  // Third-party with "settings" model config: add model env vars to settings.json
  if (agentType === "thirdparty" && modelConfigMethod === "settings" && model) {
    const existingEnv = (settings.env as Record<string, string>) || {};
    const modelEnv: Record<string, string> = {};
    for (const envVar of MODEL_ENV_VARS) {
      modelEnv[envVar] = model;
    }
    settings.env = {
      ...existingEnv,
      ...modelEnv,
    };

    logger.info("  Model env vars added to settings.json:");
    for (const envVar of MODEL_ENV_VARS) {
      logger.info(`    ${envVar}: ${model}`);
    }
  }

  writeFileSync(destPath, JSON.stringify(settings, null, 2));
  return destPath;
}

/**
 * Create an agent profile from user input
 */
function createAgentProfile(
  input: AgentInput,
  secretScriptPath: string | undefined,
  settingsPath: string | undefined
): AgentProfile {
  const envVarName = input.name.toUpperCase().replace(/-/g, "_") + "_API_KEY";

  const descriptionMap: Record<string, string> = {
    anthropic: "Anthropic agent",
    thirdparty: input.preset ? `Third-party agent (${input.preset})` : "Third-party agent",
    copilot: "Copilot agent",
  };

  const profile: AgentProfile = {
    image: input.dockerImage,
    runner: "docker",
    agent_type: agentTypeFromProvider(input.type),
    provider: input.type,
    description: descriptionMap[input.type] || `${input.type} agent`,
    interactive: true,
    tty: true,
    volumes: [
      {
        source: "${CWD}",
        target: "/workspace",
      },
    ],
    workdir: "/workspace",
    env: {},
    ...(settingsPath && { claude_settings: settingsPath }),
  };

  // Only add secrets if we have a secret script
  if (secretScriptPath) {
    profile.secrets = {
      [envVarName]: secretScriptPath,
    };
  }

  if (input.type === "thirdparty") {
    const baseEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: input.apiUrl!,
      ANTHROPIC_API_KEY: `\${${envVarName}}`,
    };

    // If using "env" model config method, add model env vars to profile
    if (input.modelConfigMethod === "env" && input.model) {
      for (const envVar of MODEL_ENV_VARS) {
        baseEnv[envVar] = input.model;
      }
    }

    // Add custom env vars (includes preset defaults and user modifications)
    if (input.customEnvVars) {
      Object.assign(baseEnv, input.customEnvVars);
    }

    profile.env = baseEnv;
  } else if (input.type === "copilot") {
    if (secretScriptPath) {
      // Dedicated token provided — expose as <NAME>_TOKEN
      const tokenEnvVar = input.name.toUpperCase().replace(/-/g, "_") + "_TOKEN";
      profile.env = {
        [tokenEnvVar]: `\${${envVarName}}`,
      };
    }
    // No dedicated token — agent uses GH_COPILOT_TOKEN/GITHUB_COPILOT_TOKEN
    // which are injected from global settings by the docker runner
  } else if (input.type === "anthropic") {
    if (secretScriptPath && input.anthropicTokenType === "oauth") {
      // OAuth/subscription token → CLAUDE_CODE_OAUTH_TOKEN
      // Clear ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL so Claude Code uses OAuth instead
      profile.env = {
        CLAUDE_CODE_OAUTH_TOKEN: `\${${envVarName}}`,
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "",
      };
    } else if (secretScriptPath && input.anthropicTokenType === "api") {
      // API billing token → ANTHROPIC_API_KEY (docker-runner maps to AUTH_TOKEN + AUTH_KEY)
      profile.env = {
        ANTHROPIC_API_KEY: `\${${envVarName}}`,
      };
    }
    // No token — profile has no token env vars, user can configure later
  }

  return profile;
}

/**
 * Configure an Anthropic agent
 */
async function configureAnthropicAgent(existingName?: string): Promise<AgentInput> {
  const baseAnswers = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter a unique name for this Anthropic agent:",
      default: existingName || "claude",
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "Agent name is required";
        }
        if (!/^[a-z0-9-_]+$/i.test(input)) {
          return "Agent name can only contain letters, numbers, hyphens, and underscores";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "dockerImage",
      message: "Docker image for this agent:",
      default: "giglabo/claude-heretic",
    },
    {
      type: "input",
      name: "token",
      message:
        "Enter your Anthropic API token (optional, press Enter to skip):",
      default: "",
      validate: (): boolean => true,
    },
  ]);

  const token = baseAnswers.token?.trim() || "";

  // If token provided, ask for token type
  let anthropicTokenType: AnthropicTokenType | undefined;
  if (token) {
    anthropicTokenType = await promptList<AnthropicTokenType>(
      "What type of Anthropic token is this?",
      [
        {
          name: "API Key (API billing → ANTHROPIC_AUTH_TOKEN)",
          value: "api",
        },
        {
          name: "OAuth Token (Claude subscription → CLAUDE_CODE_OAUTH_TOKEN)",
          value: "oauth",
        },
      ]
    );
  }

  const settingsAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "settingsPath",
      message: "Path to existing settings.json (optional, press Enter to create default):",
      default: "",
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return true; // Optional
        }
        // Expand ~ and check if file exists
        const expanded = input.startsWith("~") ? input.replace("~", process.env.HOME || "") : input;
        if (!existsSync(expanded)) {
          return `File not found: ${expanded}`;
        }
        return true;
      },
    },
  ]);

  return {
    name: baseAnswers.name,
    type: "anthropic",
    dockerImage: baseAnswers.dockerImage,
    token,
    settingsPath: settingsAnswer.settingsPath?.trim() || undefined,
    anthropicTokenType,
  };
}

/**
 * Helper function to prompt for additional env vars
 */
async function promptForAdditionalEnvVars(
  logger: ReturnType<typeof getLogger>,
  envVars: Record<string, string>
): Promise<void> {
  logger.info("\n  Enter additional environment variables (empty name to finish):\n");

  while (true) {
    const envAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "envName",
        message: "  Env var name (empty to finish):",
        validate: (input: string): string | boolean => {
          if (!input || !input.trim()) {
            return true; // Empty to finish
          }
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(input)) {
            return "Env var name must start with a letter or underscore and contain only letters, numbers, and underscores";
          }
          return true;
        },
      },
    ]);

    if (!envAnswer.envName || !envAnswer.envName.trim()) {
      break;
    }

    const valueAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "envValue",
        message: `  Value for ${envAnswer.envName}:`,
      },
    ]);

    envVars[envAnswer.envName.trim()] = valueAnswer.envValue || "";
    logger.info(`    Added: ${envAnswer.envName}=${valueAnswer.envValue || "(empty)"}`);
  }
}

/**
 * Configure a third-party agent (ZAI, Kimi, or custom provider)
 */
async function configureThirdPartyAgent(existingName?: string): Promise<AgentInput> {
  const logger = getLogger();

  // Step 1: Select provider preset
  const preset = await promptList<ThirdPartyPreset>("Select third-party provider:", [
    { name: "ZAI (api.z.ai)", value: "zai" },
    { name: "Kimi/Moonshot (api.moonshot.ai)", value: "kimi" },
    { name: "Custom (enter your own URL)", value: "custom" },
  ]);

  const defaults = THIRDPARTY_PRESET_DEFAULTS[preset];

  // Step 2: Get agent name
  const nameAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter a unique name for this agent:",
      default: existingName || defaults.defaultName,
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "Agent name is required";
        }
        if (!/^[a-z0-9-_]+$/i.test(input)) {
          return "Agent name can only contain letters, numbers, hyphens, and underscores";
        }
        return true;
      },
    },
  ]);

  // Step 3: Get API URL (pre-filled for known presets)
  const urlAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "apiUrl",
      message: "Enter the API URL:",
      default: defaults.url,
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "API URL is required";
        }
        try {
          new URL(input);
          return true;
        } catch {
          return "Please enter a valid URL";
        }
      },
    },
  ]);

  // Step 4: Get API token
  const tokenAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "token",
      message: "Enter your API token:",
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "API token is required";
        }
        return true;
      },
    },
  ]);

  // Step 5: Get Docker image
  const imageAnswer = await inquirer.prompt([
    {
      type: "input",
      name: "dockerImage",
      message: "Docker image for this agent:",
      default: "giglabo/claude-heretic",
    },
  ]);

  // Step 6: Choose model config method
  const modelConfigMethod = await promptList<"env" | "settings">(
    "How should model configuration be stored?",
    [
      {
        name: "Environment Variables (in agent profile YAML)",
        value: "env",
      },
      {
        name: "Settings JSON (in Claude settings file)",
        value: "settings",
      },
    ]
  );

  let model: string | undefined;
  let settingsPath: string | undefined;

  if (modelConfigMethod === "env") {
    // Step 7a: Get model name for env vars
    const modelAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "model",
        message: "Enter model name:",
        default: defaults.model,
        validate: (input: string): string | boolean => {
          if (!input || !input.trim()) {
            return "Model name is required";
          }
          return true;
        },
      },
    ]);
    model = modelAnswer.model;

    logger.info("\n  Model will be set via environment variables:");
    for (const envVar of MODEL_ENV_VARS) {
      logger.info(`    ${envVar}: ${model}`);
    }
  } else {
    // Step 7b: Get optional settings.json path, or enter model for new settings
    const settingsAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "settingsPath",
        message: "Path to existing settings.json (optional, press Enter to create new):",
        default: "",
        validate: (input: string): string | boolean => {
          if (!input || !input.trim()) {
            return true; // Optional
          }
          const expanded = input.startsWith("~")
            ? input.replace("~", process.env.HOME || "")
            : input;
          if (!existsSync(expanded)) {
            return `File not found: ${expanded}`;
          }
          return true;
        },
      },
    ]);
    settingsPath = settingsAnswer.settingsPath?.trim() || undefined;

    // If no existing settings path, ask for model to put in new settings.json
    if (!settingsPath) {
      const modelAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "model",
          message: "Enter model name (will be added to settings.json):",
          default: defaults.model,
          validate: (input: string): string | boolean => {
            if (!input || !input.trim()) {
              return "Model name is required";
            }
            return true;
          },
        },
      ]);
      model = modelAnswer.model;
    }
  }

  // Step 8: Show predefined env vars and ask if user wants to modify them
  // Start with preset defaults
  const customEnvVars: Record<string, string> = { ...defaults.defaultEnvVars };

  logger.info("\n  Default environment variables for this preset:");
  for (const [key, value] of Object.entries(customEnvVars)) {
    logger.info(`    ${key}=${value}`);
  }

  const modifyEnvAnswer = await promptList<"keep" | "modify" | "add">(
    "What would you like to do with environment variables?",
    [
      { name: "Keep defaults as-is", value: "keep" },
      { name: "Modify default values", value: "modify" },
      { name: "Add more env vars (keep defaults)", value: "add" },
    ]
  );

  if (modifyEnvAnswer === "modify") {
    logger.info("\n  Modify environment variables (press Enter to keep current value):\n");

    for (const [key, currentValue] of Object.entries(defaults.defaultEnvVars)) {
      const modifyAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "value",
          message: `  ${key}:`,
          default: currentValue,
        },
      ]);
      customEnvVars[key] = modifyAnswer.value;
    }

    // Also allow adding new ones
    const addMoreAnswer = await inquirer.prompt([
      {
        type: "confirm",
        name: "addMore",
        message: "Do you want to add additional environment variables?",
        default: false,
      },
    ]);

    if (addMoreAnswer.addMore) {
      await promptForAdditionalEnvVars(logger, customEnvVars);
    }
  } else if (modifyEnvAnswer === "add") {
    await promptForAdditionalEnvVars(logger, customEnvVars);
  }

  logger.info("\n  Final environment variables:");
  for (const [key, value] of Object.entries(customEnvVars)) {
    logger.info(`    ${key}=${value}`);
  }

  return {
    name: nameAnswer.name,
    type: "thirdparty",
    dockerImage: imageAnswer.dockerImage,
    token: tokenAnswer.token,
    apiUrl: urlAnswer.apiUrl,
    settingsPath,
    preset,
    modelConfigMethod,
    model,
    customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
  };
}

/**
 * Configure a Copilot agent
 */
async function configureCopilotAgent(existingName?: string): Promise<AgentInput> {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter a unique name for this Copilot agent:",
      default: existingName || "copilot",
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "Agent name is required";
        }
        if (!/^[a-z0-9-_]+$/i.test(input)) {
          return "Agent name can only contain letters, numbers, hyphens, and underscores";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "dockerImage",
      message: "Docker image for this agent:",
      validate: (input: string): string | boolean => {
        if (!input || !input.trim()) {
          return "Docker image is required";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "token",
      message:
        "Enter a dedicated API token (optional, press Enter to use global Copilot/GitHub token):",
      default: "",
      validate: (): boolean => true,
    },
  ]);

  return {
    name: answers.name,
    type: "copilot",
    dockerImage: answers.dockerImage,
    token: answers.token?.trim() || "",
  };
}

/**
 * Manage agent profiles (add, delete)
 */
async function manageAgents(): Promise<void> {
  const logger = getLogger();
  const hereticDir = getHereticDir();

  // Ensure profiles directory exists
  ensureProfilesDir();

  while (true) {
    // Get current profiles
    const profiles = listProfiles();

    // Show current agents
    if (profiles.length > 0) {
      logger.info("\n=== Current Agent Profiles ===");
      profiles.forEach((name, index) => {
        try {
          const profile = loadProfile(name);
          logger.info(`${index + 1}. ${name} - ${profile.image} (${profile.runner})`);
        } catch {
          logger.info(`${index + 1}. ${name} - (invalid profile)`);
        }
      });
    } else {
      logger.info("\nNo agent profiles configured yet.");
    }

    // Ask what to do
    const actionChoices: Array<{ name: string; value: string }> = [
      { name: "Add new agent", value: "add" },
      ...(profiles.length > 0 ? [{ name: "Delete agent", value: "delete" }] : []),
      { name: "Done managing agents", value: "done" },
    ];

    const action = await promptList("What would you like to do?", actionChoices);

    if (action === "done") {
      break;
    }

    if (action === "add") {
      // Ask for agent type
      const agentType = await promptList("Select agent type:", [
        { name: "Anthropic (direct API)", value: "anthropic" as const },
        { name: "Third-Party (ZAI, Kimi, or custom)", value: "thirdparty" as const },
        { name: "Copilot (custom API)", value: "copilot" as const },
      ]);

      let agentInput: AgentInput;
      if (agentType === "anthropic") {
        agentInput = await configureAnthropicAgent();
      } else if (agentType === "thirdparty") {
        agentInput = await configureThirdPartyAgent();
      } else {
        agentInput = await configureCopilotAgent();
      }

      // Check if profile already exists
      const profilePath = join(getProfilesDir(), `${agentInput.name}.yaml`);
      if (existsSync(profilePath)) {
        const overwrite = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirm",
            message: `Profile "${agentInput.name}" already exists. Overwrite?`,
            default: false,
          },
        ]);

        if (!overwrite.confirm) {
          logger.info("Agent not added.");
          continue;
        }
      }

      // Create secrets script (skip for copilot agents without a dedicated token)
      let secretScriptPath: string | undefined;
      if (agentInput.token) {
        secretScriptPath = createSecretsScript(hereticDir, agentInput.name, agentInput.token);
        logger.info(`✓ Created secret script: ${secretScriptPath}`);
      } else {
        logger.info("  Using global Copilot/GitHub token (no dedicated secret script)");
      }

      // Create Claude settings file (not applicable for copilot agents)
      let settingsPath: string | undefined;
      if (agentInput.type !== "copilot") {
        settingsPath = createClaudeSettings(
          hereticDir,
          agentInput.name,
          agentInput.type,
          agentInput.settingsPath,
          agentInput.modelConfigMethod,
          agentInput.model
        );
        logger.info(`✓ Created Claude settings: ${settingsPath}`);
      }

      // Create and save profile
      const profile = createAgentProfile(agentInput, secretScriptPath, settingsPath);
      saveProfile(agentInput.name, profile);
      logger.info(`✓ Created profile: ${profilePath}`);
    } else if (action === "delete") {
      const deleteChoices = profiles.map((name) => ({
        name,
        value: name,
      }));
      const agentNameToDelete = await promptList("Select agent to delete:", deleteChoices);

      const confirmDelete = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Are you sure you want to delete "${agentNameToDelete}"?`,
          default: false,
        },
      ]);

      if (confirmDelete.confirm) {
        const profilePath = join(getProfilesDir(), `${agentNameToDelete}.yaml`);
        const scriptPath = join(hereticDir, `get-${agentNameToDelete}-key.sh`);
        const settingsPath = join(hereticDir, `${agentNameToDelete}-settings.json`);

        // Delete profile
        if (existsSync(profilePath)) {
          const { unlinkSync } = await import("fs");
          unlinkSync(profilePath);
          logger.info(`✓ Deleted profile: ${profilePath}`);
        }

        // Delete secret script if exists
        if (existsSync(scriptPath)) {
          const { unlinkSync } = await import("fs");
          unlinkSync(scriptPath);
          logger.info(`✓ Deleted secret script: ${scriptPath}`);
        }

        // Delete Claude settings if exists
        if (existsSync(settingsPath)) {
          const { unlinkSync } = await import("fs");
          unlinkSync(settingsPath);
          logger.info(`✓ Deleted Claude settings: ${settingsPath}`);
        }
      }
    }
  }
}

/**
 * Initialize a new heretic project with interactive configuration
 */
export async function runInit(): Promise<void> {
  const logger = getLogger();
  logger.info("Initializing Heretic CLI settings...");

  // Load existing settings
  const hereticDir = getHereticDir();
  const existingSettings = loadSettings();
  const existingGithubScript = existingSettings.github?.token;
  const existingCopilotScript = existingSettings.github?.copilot_token;

  // Resolve existing tokens for display (execute scripts if needed)
  let existingGithubTokenValue: string | undefined;
  let existingCopilotTokenValue: string | undefined;
  try {
    if (existingGithubScript) {
      existingGithubTokenValue = resolveToken(existingGithubScript);
    }
    if (existingCopilotScript) {
      existingCopilotTokenValue = resolveToken(existingCopilotScript);
    }
  } catch {
    // Ignore resolution errors for display
  }

  logger.info(
    existingGithubTokenValue
      ? "Existing settings found. You can keep existing values by pressing Enter."
      : "No existing settings found. Let's configure your environment."
  );

  // Step 1: GitHub Tokens
  const maskedGithub = existingGithubTokenValue ? maskToken(existingGithubTokenValue) : undefined;
  const maskedCopilot = existingCopilotTokenValue
    ? maskToken(existingCopilotTokenValue)
    : undefined;

  const githubAnswers = await inquirer.prompt([
    {
      type: "input",
      name: "githubToken",
      message: "Enter your GitHub token:",
      default: maskedGithub,
      validate: (input: string): string | boolean => {
        if (maskedGithub && input === maskedGithub) {
          return true;
        }
        if (!input || !input.trim()) {
          return "GitHub token is required";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "copilotToken",
      message: "Enter GitHub Copilot token (optional, press Enter to use primary token):",
      default: maskedCopilot,
      validate: (): boolean => true,
    },
  ]);

  // Determine if tokens changed or user kept existing
  let githubScriptPath: string;
  if (maskedGithub && githubAnswers.githubToken === maskedGithub) {
    // User kept existing token
    githubScriptPath = existingGithubScript!;
  } else {
    // New token - create secret script
    githubScriptPath = createSecretsScript(hereticDir, "github-token", githubAnswers.githubToken);
    logger.info(`✓ Created GitHub token script: ${githubScriptPath}`);
  }

  let copilotScriptPath: string | undefined;
  if (githubAnswers.copilotToken) {
    if (maskedCopilot && githubAnswers.copilotToken === maskedCopilot) {
      // User kept existing copilot token
      copilotScriptPath = existingCopilotScript;
    } else if (githubAnswers.copilotToken.trim()) {
      // New copilot token - create secret script
      copilotScriptPath = createSecretsScript(
        hereticDir,
        "copilot-token",
        githubAnswers.copilotToken.trim()
      );
      logger.info(`✓ Created Copilot token script: ${copilotScriptPath}`);
    }
  }

  // Save script paths in settings (not raw tokens)
  const newSettings: HereticSettings = {
    github: {
      token: githubScriptPath,
      ...(copilotScriptPath && { copilot_token: copilotScriptPath }),
    },
  };

  saveSettings(newSettings);
  logger.info("✓ GitHub settings saved to ~/.heretic/settings.yaml");

  // Step 2: Manage Agent Profiles
  logger.info("\n=== Agent Configuration ===");
  await manageAgents();

  // Show final summary
  logger.info("\n=== Configuration Complete ===");
  try {
    const resolvedGithub = resolveToken(githubScriptPath);
    logger.info(`GitHub Token: ${maskToken(resolvedGithub)}`);
  } catch {
    logger.info(`GitHub Token: (script: ${githubScriptPath})`);
  }
  if (copilotScriptPath) {
    try {
      const resolvedCopilot = resolveToken(copilotScriptPath);
      logger.info(`GitHub Copilot Token: ${maskToken(resolvedCopilot)}`);
    } catch {
      logger.info(`GitHub Copilot Token: (script: ${copilotScriptPath})`);
    }
  } else {
    logger.info("GitHub Copilot Token: (using primary token)");
  }

  const profiles = listProfiles();
  if (profiles.length > 0) {
    logger.info(`\nAgent Profiles: ${profiles.length}`);
    profiles.forEach((name) => {
      logger.info(`  - ${name}`);
    });
    logger.info(`\nRun an agent with: heretic <profile-name>`);
  } else {
    logger.info("\nNo agent profiles configured. Run 'heretic agents add <name>' to create one.");
  }
}
