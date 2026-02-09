/**
 * Docker Runner Agent Profile Types
 *
 * These types define the structure for agent profiles, local overrides,
 * and resolved configuration used by the Docker runner system.
 */

/**
 * Runner type discriminator
 */
export type RunnerType = "docker" | "compose" | "custom";

/**
 * Agent type - determines agent-specific behavior like MCP mount paths
 */
export type AgentType = "claude" | "aider" | "copilot-cli" | "generic";

/**
 * Provider type - determines API provider behavior and env var handling
 */
export type ProviderType = "anthropic" | "thirdparty" | "copilot";

/**
 * Derive agent_type from provider type.
 * Copilot provider maps to copilot-cli agent; all others default to claude.
 */
export function agentTypeFromProvider(provider: ProviderType): AgentType {
  return provider === "copilot" ? "copilot-cli" : "claude";
}

/**
 * Infer provider from agent_type when provider is not explicitly set.
 * copilot-cli → copilot; all others → anthropic (default).
 */
export function providerFromAgentType(agentType: AgentType): ProviderType {
  return agentType === "copilot-cli" ? "copilot" : "anthropic";
}

/**
 * Volume mount configuration
 */
export interface VolumeMount {
  /** Source path on the host (can contain ${VAR} placeholders) */
  source: string;
  /** Target path inside the container */
  target: string;
  /** Whether the mount is read-only */
  readonly?: boolean;
}

/**
 * Environment variable context for interpolation
 */
export interface VariableContext {
  /** Current working directory */
  CWD: string;
  /** User home directory */
  HOME: string;
  /** Additional environment variables from process.env */
  [key: string]: string | undefined;
}

/**
 * Compose service configuration (additional services alongside the main agent)
 */
export interface ComposeServiceConfig {
  /** Docker image for this service */
  image: string;
  /** Environment variables */
  environment?: Record<string, string> | string[];
  /** Port mappings */
  ports?: string[];
  /** Volume mounts */
  volumes?: string[];
  /** Additional service options (passed through to docker-compose) */
  [key: string]: unknown;
}

/**
 * Compose-specific configuration
 */
export interface ComposeConfig {
  /** Additional services to run alongside the main agent */
  services?: Record<string, ComposeServiceConfig>;
  /** Custom networks */
  networks?: Record<string, unknown>;
  /** Named volumes */
  volumes?: Record<string, unknown>;
}

/**
 * SSH backend configuration for remote agent execution
 */
export interface SshConfig {
  /** SSH host to connect to */
  host: string;
  /** SSH port (default: 22) */
  port?: number;
  /** SSH user (default: "agent") */
  user?: string;
  /** Path to SSH private key (default: ~/.ssh/id_rsa) */
  key_path?: string;
  /** Working directory on the remote host */
  host_cwd?: string;
}

/**
 * MCP server configuration
 */
export interface McpServer {
  /** Server name (used as key in .mcp.json) */
  name: string;
  /** Command to start the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the server */
  env?: Record<string, string>;
}

/**
 * Git configuration for the agent
 */
export interface GitConfig {
  /** GitHub/Git token for authentication */
  token?: string;
  /** Git author name */
  author_name?: string;
  /** Git author email */
  author_email?: string;
}

/**
 * Secrets configuration - maps env var names to scripts that output the value
 *
 * @example
 * secrets:
 *   ANTHROPIC_API_KEY: "~/.heretic/get-anthropic-key.sh"
 *   ZAI_API_KEY: "~/.heretic/get-secret.sh zai"
 */
export type SecretsConfig = Record<string, string>;

/**
 * Extra Docker options for the agent container
 */
export interface AgentProfileExtra {
  /** Docker network mode */
  network?: string;
  /** Port mappings (host:container format) */
  ports?: string[];
  /** Linux capabilities to add */
  capabilities?: string[];
  /** Privileged mode */
  privileged?: boolean;
  /** User:Group inside container */
  user?: string;
  /** Container hostname */
  hostname?: string;
  /** Memory limit (e.g., "4g", "512m") */
  memory?: string;
  /** CPU limit (e.g., "2.0") */
  cpus?: string;
  /** Shared memory size (e.g., "2g") */
  shm_size?: string;
  /** Additional container labels (merged with heretic defaults) */
  labels?: Record<string, string>;
}

/**
 * Complete agent profile (stored in ~/.heretic/agents/*.yaml)
 */
export interface AgentProfile {
  /** Docker image to use */
  image: string;
  /** Type of runner to use */
  runner?: RunnerType;
  /** Agent type - determines agent-specific behavior (default: "claude") */
  agent_type?: AgentType;
  /** Provider type - determines API provider behavior (default: "anthropic") */
  provider?: ProviderType;
  /** Volume mounts */
  volumes?: VolumeMount[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory inside the container */
  workdir?: string;
  /** Command to run (overrides image CMD) */
  command?: string[];
  /** Enable interactive mode (stdin) */
  interactive?: boolean;
  /** Enable TTY mode */
  tty?: boolean;
  /** Additional Docker options */
  extra?: AgentProfileExtra;
  /** Compose-specific configuration (only used when runner is "compose") */
  compose?: ComposeConfig;
  /** SSH backend configuration */
  ssh?: SshConfig;
  /** MCP server configurations */
  mcp?: McpServer[];
  /** Path to a JSON file containing MCP server definitions (supports mcpServers, servers, or bare format) */
  mcp_file?: string;
  /** Override existing .mcp.json in workspace (default: false - skip if exists) */
  mcp_override?: boolean;
  /** Git configuration */
  git?: GitConfig;
  /** Enable Docker-in-Docker (mount docker.sock) */
  dind?: boolean;
  /** Secrets - maps env var names to scripts that output the value */
  secrets?: SecretsConfig;
  /** Path to Claude Code settings.json file to mount into container */
  claude_settings?: string;
  /** Profile name (derived from filename) */
  name?: string;
  /** Human-readable description */
  description?: string;
  /** Whether this profile is enabled */
  enabled?: boolean;
}

/**
 * Local override configuration (stored in .heretic/agent.yaml)
 * Extends a global profile with project-specific overrides
 */
export interface LocalOverride extends Partial<AgentProfile> {
  /** Name of the global profile to extend */
  extends?: string;
}

/**
 * Fully resolved agent configuration after merging all layers
 * This is what the runner uses to start containers
 */
export interface ResolvedAgentConfig {
  /** Profile name */
  name: string;
  /** Docker image */
  image: string;
  /** Runner backend */
  runner: RunnerType;
  /** Agent type - determines agent-specific behavior */
  agentType: AgentType;
  /** Provider type - determines API provider behavior */
  provider: ProviderType;
  /** Volume mounts */
  volumes: VolumeMount[];
  /** Environment variables */
  env: Record<string, string>;
  /** Working directory */
  workdir: string;
  /** Command to run */
  command: string[];
  /** Interactive mode */
  interactive: boolean;
  /** TTY mode */
  tty: boolean;
  /** Additional Docker options */
  extra: AgentProfileExtra;
  /** Compose-specific configuration */
  compose?: ComposeConfig;
  /** SSH backend configuration */
  ssh?: SshConfig;
  /** MCP server configurations */
  mcp?: McpServer[];
  /** Override existing .mcp.json in workspace (default: false - skip if exists) */
  mcpOverride: boolean;
  /** Git configuration */
  git?: GitConfig;
  /** Enable Docker-in-Docker (mount docker.sock) */
  dind: boolean;
  /** Absolute path to project directory */
  projectDir: string;
  /** Session name for this run (default: "default") */
  sessionName: string;
  /** Resolved secrets (env var name → value) - already executed */
  secrets?: Record<string, string>;
  /** Path to Claude Code settings.json file to mount into container */
  claudeSettings?: string;
}

/**
 * Result of config validation
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
  /** List of warnings */
  warnings: string[];
}

/**
 * Validation error with location context
 */
export interface ValidationError {
  /** Field path (e.g., "volumes[0].source") */
  field: string;
  /** Error message */
  message: string;
  /** File path where the error occurred */
  file?: string;
  /** Line number (if available) */
  line?: number;
}
