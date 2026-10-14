import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

/**
 * Abstract interface for profile path resolution
 * Allows testing with temporary directories instead of real home directory
 */
export interface ProfilePathProvider {
  /**
   * Get the base heretic directory (e.g., ~/.heretic)
   */
  getHereticDir(): string;

  /**
   * Get the agents directory (e.g., ~/.heretic/agents)
   */
  getAgentsDir(): string;

  /**
   * Get the path to the settings file (e.g., ~/.heretic/settings.yaml)
   */
  getSettingsPath(): string;

  /**
   * Ensure the agents directory exists
   */
  ensureAgentsDir(): void;
}

/**
 * Default implementation using the real home directory
 */
export class HomeProfilePathProvider implements ProfilePathProvider {
  getHereticDir(): string {
    return join(homedir(), ".heretic");
  }

  getAgentsDir(): string {
    return join(this.getHereticDir(), "agents");
  }

  getSettingsPath(): string {
    return join(this.getHereticDir(), "settings.yaml");
  }

  ensureAgentsDir(): void {
    const agentsDir = this.getAgentsDir();
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }
  }
}

/**
 * Test implementation using a custom base directory
 */
export class TestProfilePathProvider implements ProfilePathProvider {
  constructor(private baseDir: string) {}

  getHereticDir(): string {
    return this.baseDir;
  }

  getAgentsDir(): string {
    return join(this.baseDir, "agents");
  }

  getSettingsPath(): string {
    return join(this.baseDir, "settings.yaml");
  }

  ensureAgentsDir(): void {
    const agentsDir = this.getAgentsDir();
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }
  }
}

/**
 * Global instance used by profile-loader
 * Can be overridden for testing
 */
let globalPathProvider: ProfilePathProvider = new HomeProfilePathProvider();

/**
 * Get the current global path provider
 */
export function getPathProvider(): ProfilePathProvider {
  return globalPathProvider;
}

/**
 * Set the global path provider (for testing)
 */
export function setPathProvider(provider: ProfilePathProvider): void {
  globalPathProvider = provider;
}

/**
 * Reset to default home directory provider
 */
export function resetPathProvider(): void {
  globalPathProvider = new HomeProfilePathProvider();
}
