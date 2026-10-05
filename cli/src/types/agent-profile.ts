/**
 * Docker Runner Agent Profile Types
 *
 * These types define the structure for agent profiles, local overrides,
 * and resolved configuration used by the Docker runner system.
 */

import type { PortMapping } from "../utils/ports";

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
 * Build-sidecar runtime keys.
 *
 * MUST be one of these five — the agent-side wrapper generator
 * (`entrypoint.sh:setup_tool_wrappers`) only knows these runtimes, and any
 * other key silently routes nothing (tool-execution-backends spec gap B-3).
 */
export type SidecarRuntime = "node" | "python" | "java" | "go" | "rust";

/** Canonical list of valid sidecar runtimes (validation + iteration). */
export const SIDECAR_RUNTIMES: readonly SidecarRuntime[] = ["node", "python", "java", "go", "rust"];

/**
 * A single HTTP build sidecar: a sibling container running an `exec-server`
 * that shares the agent's workspace and provides one runtime's toolchain.
 * The agent's tool wrappers (`npm`, `pip`, …) POST commands to it.
 */
export interface BuildSidecar {
  /** Runtime key — MUST be one of node|python|java|go|rust (02-contracts §1) */
  runtime: SidecarRuntime;
  /** Builder image exposing the exec-server (e.g. heretic-builder-node:latest) */
  image: string;
  /** Port the exec-server listens on inside the container (default: 8080) */
  port?: number;
  /** Command override (default: exec-server -port <port> -cwd <workspace_target>) */
  command?: string[];
  /** Environment variables injected into the builder container */
  env?: Record<string, string>;
  /** Allowlist of env var names forwarded per-exec into builds (gap C-8) */
  env_passthrough?: string[];
  /** Named cache volumes for warm caches, as "<name>:<target>" (gap F-3) */
  cache_volumes?: string[];
  /** Raw compose healthcheck override (passed through verbatim) */
  healthcheck?: Record<string, unknown>;
}

/**
 * Tool-execution backend configuration.
 *
 * Currently models the HTTP build-sidecar backend. The SSH backend keeps its
 * own top-level `ssh:` block; both resolve into the same wrapper mechanism
 * inside the container.
 */
export interface ToolBackends {
  /** Build sidecars, at most one per runtime */
  sidecars?: BuildSidecar[];
  /** Shared workspace mount target (must match a volume target; default "/workspace") */
  workspace_target?: string;
  /** Seconds to wait for each sidecar to become healthy (default: 60) */
  ready_timeout?: number;
  /**
   * Run builders as the caller's uid:gid so build artefacts are caller-owned
   * rather than root-owned (default: true, gap F-2).
   */
  run_as_caller_uid?: boolean;
}

/**
 * MCP server transport type
 */
export type McpTransportType = "stdio" | "http";

/**
 * MCP server configuration
 *
 * Supports two transport types:
 * - **stdio** (default): requires `command`, optionally `args`
 * - **http**: requires `url`, optionally `headers`
 */
export interface McpServer {
  /** Server name (used as key in .mcp.json) */
  name: string;
  /** Transport type (default: "stdio") */
  type?: McpTransportType;
  /** Command to start the MCP server (required for stdio) */
  command?: string;
  /** Arguments to pass to the command (stdio only) */
  args?: string[];
  /** URL of the MCP server (required for http) */
  url?: string;
  /** HTTP headers for the MCP server (http only) */
  headers?: Record<string, string>;
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
  /**
   * Published ports, `docker run -p` syntax: "3000", "3000-3020",
   * "13000-13020:3000-3020", "127.0.0.1:8080:8080", "5353/udp"
   */
  ports?: string[];
  /** Named sets of typical dev ports (dev, web, debug, db, supabase, mail, all) */
  port_presets?: string[];
  /** Host interface for ports that don't name one (default: Docker's, all interfaces) */
  ports_host_ip?: string;
  /** Shift host ports of specs without an explicit host port, presets included */
  ports_offset?: number;
  /** Linux capabilities to add */
  capabilities?: string[];
  /** Privileged mode */
  privileged?: boolean;
  /** User:Group inside container */
  user?: string;
  /**
   * Run the container as root instead of dropping to the agent user, while
   * still using the agent user's home directory (/home/agent) as HOME so all
   * bind-mounted config (claude settings, auth, ssh keys, etc.) keeps working.
   */
  run_as_root?: boolean;
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
  /** Tool-execution backends (HTTP build sidecars) */
  tool_backends?: ToolBackends;
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
  /**
   * Published ports after expanding presets, offset and host IP; mirrored as
   * compact specs in `extra.ports`. Undefined when nothing is published.
   */
  portMappings?: PortMapping[];
  /** Compose-specific configuration */
  compose?: ComposeConfig;
  /** SSH backend configuration */
  ssh?: SshConfig;
  /** Tool-execution backends (HTTP build sidecars) */
  toolBackends?: ToolBackends;
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
