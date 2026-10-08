/**
 * Settings types for Heretic CLI
 * Stored in ~/.heretic/settings.yaml
 */

export interface HereticSettings {
  github?: GithubConfig;
  agents?: AgentConfig[];
}

export interface GithubConfig {
  /** Primary GitHub token */
  token: string;
  /** Optional GitHub Copilot token (falls back to primary token if not set) */
  copilot_token?: string;
}

/**
 * Base agent configuration shared by all agent types
 */
export interface BaseAgentConfig {
  name: string;
  type: "anthropic" | "thirdparty" | "copilot";
  enabled: boolean;
  docker_image: string;
}

/**
 * Anthropic-specific agent configuration
 */
export interface AnthropicAgentConfig extends BaseAgentConfig {
  type: "anthropic";
  billing_type: "subscription" | "pay_as_you_go";
  token: string;
}

/**
 * Third-party provider preset type
 */
export type ThirdPartyPreset = "zai" | "kimi" | "custom";

/**
 * Third-party agent configuration (supports ZAI, Kimi, and custom API providers)
 */
export interface ThirdPartyAgentConfig extends BaseAgentConfig {
  type: "thirdparty";
  /** Provider preset (zai, kimi, or custom) */
  preset?: ThirdPartyPreset;
  api_url: string;
  token: string;
  /** Model configuration method: "env" for environment variables, "settings" for settings.json */
  model_config?: "env" | "settings";
  /** Model name (used when model_config is "env") */
  model?: string;
}

/**
 * Copilot-specific agent configuration
 */
export interface CopilotAgentConfig extends BaseAgentConfig {
  type: "copilot";
  token: string;
}

/**
 * Union type of all agent configurations
 */
export type AgentConfig = AnthropicAgentConfig | ThirdPartyAgentConfig | CopilotAgentConfig;
