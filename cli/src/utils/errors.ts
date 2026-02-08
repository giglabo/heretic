/**
 * Base error class for Heretic CLI errors with optional user-facing suggestions.
 */
export class HereticError extends Error {
  suggestion?: string;

  constructor(message: string, suggestion?: string) {
    super(message);
    this.name = this.constructor.name;
    this.suggestion = suggestion;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when a requested profile cannot be found.
 */
export class ProfileNotFoundError extends HereticError {
  constructor(name: string) {
    super(
      `Profile '${name}' not found`,
      "Run 'heretic agents list' to see available profiles, or 'heretic agents add <name>' to create one."
    );
  }
}

/**
 * Thrown when Docker daemon is not available or not running.
 */
export class DockerNotAvailableError extends HereticError {
  constructor() {
    super(
      "Docker is not available",
      "Make sure Docker is installed and running. On macOS, start Docker Desktop."
    );
  }
}

/**
 * Thrown when configuration validation fails.
 */
export class ConfigValidationError extends HereticError {
  constructor(errors: string[]) {
    super(
      `Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      "Run 'heretic local-validate' to see all issues."
    );
  }
}

/**
 * Thrown when a runner encounters an error during execution.
 */
export class RunnerError extends HereticError {
  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Thrown when a local configuration is not found.
 */
export class LocalConfigNotFoundError extends HereticError {
  constructor(projectDir: string, profileName?: string) {
    const msg = profileName
      ? `No local configuration found for profile '${profileName}' in ${projectDir}`
      : `No local configuration found in ${projectDir}`;
    const hint = profileName
      ? `Run 'heretic local-init ${profileName}' to create a local override.`
      : "Run 'heretic local-init <profile>' to create a local agent configuration.";
    super(msg, hint);
  }
}
