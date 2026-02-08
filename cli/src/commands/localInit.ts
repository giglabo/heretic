import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getLogger } from "../logger";
import { listProfiles, loadProfile } from "../utils/profile-loader";
import { getLocalConfigPath, getLocalComposePath } from "../utils/local-config";
import { promptList } from "../utils/prompt";

/**
 * Detect the provider type of a profile
 * Uses the provider field if set, otherwise falls back to env var detection
 */
function getProfileProvider(profileName: string): "anthropic" | "thirdparty" | "copilot" {
  try {
    const profile = loadProfile(profileName);
    if (profile.provider) {
      return profile.provider;
    }
    // Backward compat: detect from env vars (third-party providers use ANTHROPIC_BASE_URL)
    const baseUrl = profile.env?.ANTHROPIC_BASE_URL || "";
    if (baseUrl) {
      return "thirdparty";
    }
    return "anthropic";
  } catch {
    return "anthropic";
  }
}

/**
 * Generate local claude-settings.json template for headless agent containers.
 * Uses dangerouslySkipPermissions for fully autonomous operation inside Docker.
 */
function generateClaudeSettingsTemplate(_provider: "anthropic" | "thirdparty" | "copilot"): string {
  return JSON.stringify(
    {
      dangerouslySkipPermissions: true,
      enabledMcpjsonServers: [],
      allowedTools: [
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "mcp__*",
      ],
    },
    null,
    2
  );
}

/**
 * Generate commented local agent.yaml template
 */
function generateAgentYamlTemplate(profileName: string): string {
  return `# Local agent configuration for ${profileName}
# Extends the global profile from ~/.heretic/agents/${profileName}.yaml

# Secrets - scripts that output sensitive values (merged with profile secrets)
# Scripts must be executable and output the secret value to stdout
# secrets:
#   ANTHROPIC_API_KEY: "~/.heretic/get-anthropic-key.sh"
#   ZAI_API_KEY: "~/.heretic/get-secret.sh zai"
#   GH_TOKEN: "~/.heretic/get-gh-token.sh"

# Override environment variables (secrets are auto-injected, can also reference via \${VAR})
# env:
#   PROJECT_NAME: "my-project"
#   NODE_ENV: "development"
#   DEBUG: "app:*"

# Override volumes (replaces entire array from profile)
# volumes:
#   - source: "\${CWD}"
#     target: "/workspace"
#     readonly: false
#   - source: "\${CWD}/.env"
#     target: "/workspace/.env"
#     readonly: true

# Override working directory
# workdir: "/workspace"

# Override container command
# command: ["--profile", "custom"]

# Override additional Docker options
# extra:
#   ports:
#     - "3000:3000"
#     - "5173:5173"
#   memory: "4g"
#   cpus: "2.0"

# SSH backend configuration (for remote agent execution)
# ssh:
#   host: "dev-server.example.com"
#   port: 22
#   user: "agent"
#   key_path: "\${HOME}/.ssh/id_rsa"
#   host_cwd: "/home/agent/workspace"

# MCP server configurations (replaces entire array from profile)
# mcp:
#   - name: "filesystem"
#     command: "npx"
#     args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
#   - name: "github"
#     command: "npx"
#     args: ["-y", "@modelcontextprotocol/server-github"]
#     env:
#       GITHUB_TOKEN: "\${GH_TOKEN}"

# Git configuration
# git:
#   token: "\${GH_TOKEN}"
#   author_name: "Agent"
#   author_email: "agent@example.com"

# Enable Docker-in-Docker (mounts docker.sock into container)
# dind: false
`;
}

/**
 * Generate compose.yaml template
 */
function generateComposeYamlTemplate(): string {
  return `# Custom Docker Compose configuration
# Used when runner is set to "custom" in agent.yaml
version: "3.8"

services:
  agent:
    image: giglabo/claude-heretic:latest
    volumes:
      - .:/workspace
    environment:
      - ANTHROPIC_API_KEY
    stdin_open: true
    tty: true
    working_dir: /workspace
    network_mode: host

  # Add additional services as needed
  # db:
  #   image: postgres:16
  #   environment:
  #     POSTGRES_PASSWORD: devpass
  #   ports:
  #     - "5432:5432"
  #
  # redis:
  #   image: redis:7-alpine
  #   ports:
  #     - "6379:6379"
`;
}

/**
 * Check if .gitignore exists and contains .heretic/cli/
 * Returns suggestion message if .heretic/cli/ should be added
 */
function checkGitignore(projectDir: string): string | null {
  const gitignorePath = join(projectDir, ".gitignore");

  if (!existsSync(gitignorePath)) {
    return null; // No .gitignore file
  }

  try {
    const content = readFileSync(gitignorePath, "utf-8");
    const lines = content.split("\n");

    // Check if .heretic/cli/ is already mentioned
    const hasHereticCli = lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === ".heretic/cli/" ||
        trimmed === ".heretic/cli" ||
        trimmed === "/.heretic/cli/" ||
        trimmed === "/.heretic/cli"
      );
    });

    if (hasHereticCli) {
      return null; // Already in .gitignore
    }

    return "Consider adding '.heretic/cli/' to your .gitignore to exclude local config from version control.";
  } catch (error) {
    return null; // Can't read .gitignore
  }
}

/**
 * Initialize heretic for local development
 */
export async function runLocalInit(
  profileName?: string,
  options: { compose?: boolean; force?: boolean } = {}
): Promise<void> {
  const logger = getLogger();
  const projectDir = process.cwd();
  const hereticCliDir = join(projectDir, ".heretic", "cli");

  // Handle compose mode
  if (options.compose) {
    const composePath = getLocalComposePath(projectDir);

    // Check if compose.yaml already exists
    if (existsSync(composePath) && !options.force) {
      logger.error(`File already exists: ${composePath}`);
      logger.info("Use --force to overwrite");
      process.exit(1);
    }

    // Create .heretic/cli directory if it doesn't exist
    if (!existsSync(hereticCliDir)) {
      mkdirSync(hereticCliDir, { recursive: true });
    }

    // Write compose.yaml template
    const template = generateComposeYamlTemplate();
    writeFileSync(composePath, template, "utf-8");

    logger.info(`Created ${composePath}`);

    // Check .gitignore
    const gitignoreSuggestion = checkGitignore(projectDir);
    if (gitignoreSuggestion) {
      logger.info(`\n${gitignoreSuggestion}`);
    }

    return;
  }

  // Get profile name (from argument or prompt)
  let selectedProfile = profileName;

  if (!selectedProfile) {
    const profiles = listProfiles();

    if (profiles.length === 0) {
      logger.error("No agent profiles found in ~/.heretic/agents/");
      logger.info("Run 'heretic init' to configure agent profiles first.");
      process.exit(1);
    }

    // Prompt user to select a profile (compiled-binary-safe)
    selectedProfile = await promptList(
      "Select an agent profile to extend:",
      profiles.map((p) => ({ name: p, value: p }))
    );
  } else {
    // Verify the profile exists
    const profiles = listProfiles();
    if (!profiles.includes(selectedProfile)) {
      logger.error(`Profile '${selectedProfile}' not found in ~/.heretic/agents/`);
      logger.info(`Available profiles: ${profiles.join(", ")}`);
      process.exit(1);
    }
  }

  // Handle per-profile config mode
  const configPath = getLocalConfigPath(projectDir, selectedProfile);

  // Check if config already exists
  if (existsSync(configPath) && !options.force) {
    logger.error(`File already exists: ${configPath}`);
    logger.info("Use --force to overwrite");
    process.exit(1);
  }

  // Check for legacy agent.yaml that extends the same profile
  const legacyPath = join(projectDir, ".heretic", "cli", "agent.yaml");
  if (existsSync(legacyPath) && configPath !== legacyPath) {
    logger.info(
      `Note: Legacy .heretic/cli/agent.yaml exists. Per-profile file ${selectedProfile}.yaml takes precedence.`
    );
  }

  // Create .heretic/cli directory if it doesn't exist
  if (!existsSync(hereticCliDir)) {
    mkdirSync(hereticCliDir, { recursive: true });
  }

  // Create .heretic/temp/ directory (session subdirs created on-demand by runners)
  const tempDir = join(projectDir, ".heretic", "temp");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
    logger.info(`Created ${tempDir}`);
  }

  // Create claude-settings.json if it doesn't exist (or --force)
  // This file is auto-detected and merged with global settings at runtime
  const claudeSettingsPath = join(hereticCliDir, "claude-settings.json");
  if (!existsSync(claudeSettingsPath) || options.force) {
    const provider = getProfileProvider(selectedProfile);
    const template = generateClaudeSettingsTemplate(provider);
    const providerLabel =
      provider === "thirdparty"
        ? "Third-Party"
        : provider === "copilot"
          ? "Copilot"
          : "Anthropic";
    writeFileSync(claudeSettingsPath, template + "\n", "utf-8");
    logger.info(`Created ${claudeSettingsPath} (${providerLabel} template)`);
    logger.info("  This file is auto-merged with global settings at runtime");
  }

  // Generate and write per-profile config
  const template = generateAgentYamlTemplate(selectedProfile);
  writeFileSync(configPath, template, "utf-8");

  logger.info(`Created ${configPath}`);

  // Check .gitignore
  const gitignoreSuggestion = checkGitignore(projectDir);
  if (gitignoreSuggestion) {
    logger.info(`\n${gitignoreSuggestion}`);
  }
}
