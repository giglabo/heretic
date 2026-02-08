import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { VariableContext, SecretsConfig } from "../types/agent-profile";
import { getLogger } from "../logger";

/**
 * Resolve ${VAR} placeholders in a single string.
 *
 * @param template - String containing ${VAR} placeholders
 * @param context - Variable context with CWD, HOME, and env vars
 * @returns String with all placeholders resolved
 *
 * @example
 * interpolate("${CWD}/src", { CWD: "/app", HOME: "/home" })
 * // => "/app/src"
 *
 * @example
 * interpolate("$${LITERAL}", ctx)
 * // => "${LITERAL}"
 */
export function interpolate(template: string, context: VariableContext): string {
  const logger = getLogger();

  // First handle escaped variables: $${...} -> ${...}
  let result = template.replace(/\$\$\{([^}]+)\}/g, "ESCAPED_PLACEHOLDER_$1");

  // Then handle regular variables: ${VAR}
  result = result.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = context[varName];

    if (value === undefined) {
      logger.warn(`Variable "${varName}" is undefined, resolving to empty string`);
      return "";
    }

    return value;
  });

  // Finally restore escaped placeholders
  result = result.replace(/ESCAPED_PLACEHOLDER_([^}]+)/g, "${$1}");

  return result;
}

/**
 * Deep-walk an object and interpolate all string values.
 *
 * @param config - Configuration object to interpolate
 * @param context - Variable context with CWD, HOME, and env vars
 * @returns New object with all string values interpolated
 *
 * @example
 * interpolateConfig({ env: { KEY: "${HOME}/.config" } }, ctx)
 * // => { env: { KEY: "/home/user/.config" } }
 *
 * @example
 * interpolateConfig({ count: 5, flag: true }, ctx)
 * // => { count: 5, flag: true } (non-strings unchanged)
 */
export function interpolateConfig<T extends object>(config: T, context: VariableContext): T {
  // Handle arrays
  if (Array.isArray(config)) {
    return config.map((item) => {
      if (typeof item === "string") {
        return interpolate(item, context);
      } else if (item !== null && typeof item === "object") {
        return interpolateConfig(item, context);
      }
      return item;
    }) as T;
  }

  // Handle objects
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      result[key] = interpolate(value, context);
    } else if (value !== null && typeof value === "object") {
      result[key] = interpolateConfig(value, context);
    } else {
      // Leave numbers, booleans, null unchanged
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Build a VariableContext from the current environment.
 *
 * @param cwd - Current working directory path
 * @returns Variable context with CWD, HOME, and all process.env variables
 *
 * @example
 * buildVariableContext("/app")
 * // => { CWD: "/app", HOME: "/home/user", PATH: "...", ... }
 */
export function buildVariableContext(cwd: string): VariableContext {
  return {
    CWD: cwd,
    HOME: homedir(),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([_key, value]) => value !== undefined)
    ),
  } as VariableContext;
}

/**
 * Expand ~ to home directory and resolve relative paths.
 *
 * @param scriptPath - Script path that may contain ~ or be relative
 * @returns Absolute path to the script
 */
function expandScriptPath(scriptPath: string): string {
  // Expand ~ to home directory
  if (scriptPath.startsWith("~/")) {
    scriptPath = resolve(homedir(), scriptPath.slice(2));
  } else if (scriptPath.startsWith("~")) {
    scriptPath = resolve(homedir(), scriptPath.slice(1));
  }

  return scriptPath;
}

/**
 * Determine the shell to use for a given script path on the current platform.
 *
 * On Unix: always uses the default shell (sh).
 * On Windows: .sh → bash (from Git Bash / WSL), .ps1 → powershell, .cmd/.bat → cmd.exe (default).
 *
 * @param scriptPath - Absolute path to the script file
 * @returns Shell string to pass to execSync, or true for platform default
 */
function shellForScript(scriptPath: string): string | true {
  if (process.platform !== "win32") {
    return true; // Unix: default shell handles everything
  }

  const ext = scriptPath.slice(scriptPath.lastIndexOf(".")).toLowerCase();

  if (ext === ".sh") {
    return "bash"; // Git Bash or WSL bash
  }
  if (ext === ".ps1") {
    return "powershell -ExecutionPolicy Bypass -File";
  }
  // .cmd, .bat, or anything else → default Windows shell (cmd.exe)
  return true;
}

/**
 * Build the full command string, accounting for shell type.
 *
 * For powershell -File mode, the script path is an argument to the shell flag,
 * so it must NOT be wrapped in the usual quoting. For all other shells, the
 * script path is quoted normally.
 */
function buildSecretCommand(
  scriptPath: string,
  quotedArgs: string[],
  shell: string | true
): string {
  // PowerShell -File: the shell string already contains the invocation prefix
  if (typeof shell === "string" && shell.includes("-File")) {
    const args = quotedArgs.length > 0 ? ` ${quotedArgs.join(" ")}` : "";
    return `${shell} "${scriptPath}"${args}`;
  }

  const args = quotedArgs.length > 0 ? ` ${quotedArgs.join(" ")}` : "";
  return `"${scriptPath}"${args}`;
}

/**
 * Execute a secret script and return its output.
 *
 * Cross-platform: on Windows, .sh scripts run via bash, .ps1 via powershell,
 * .cmd/.bat via cmd.exe. On Unix, all scripts run via the default shell.
 *
 * @param scriptCommand - Script path with optional arguments (e.g., "~/.heretic/get-key.sh arg1")
 * @returns Trimmed stdout from the script
 * @throws Error if script doesn't exist, fails to execute, or returns non-zero
 */
function executeSecretScript(scriptCommand: string): string {
  const logger = getLogger();

  // Parse command and arguments - handles quoted strings
  const parts = scriptCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [scriptCommand];
  const scriptPath = expandScriptPath(parts[0].replace(/^"|"$/g, "")); // Strip quotes from path
  const rawArgs = parts.slice(1);

  // Check if script exists (only check the script file, not with args)
  if (!existsSync(scriptPath)) {
    throw new Error(`Secret script not found: ${scriptPath}`);
  }

  // Build full command - preserve quoting for args that had quotes
  const quotedArgs = rawArgs.map((arg) => {
    // If arg was already quoted, keep it quoted
    if (arg.startsWith('"') && arg.endsWith('"')) {
      return arg;
    }
    // Quote args that contain spaces
    if (arg.includes(" ")) {
      return `"${arg}"`;
    }
    return arg;
  });

  const shell = shellForScript(scriptPath);
  const fullCommand = buildSecretCommand(scriptPath, quotedArgs, shell);

  logger.debug({ scriptPath, args: quotedArgs, shell: String(shell) }, "Executing secret script");

  try {
    const output = execSync(fullCommand, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000, // 30 second timeout
      shell: shell,
    });

    const value = output.trim();

    if (!value) {
      logger.warn({ scriptPath }, "Secret script returned empty value");
    }

    return value;
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer };
    const stderr = err.stderr?.toString().trim() || "Unknown error";
    throw new Error(`Secret script failed (${scriptPath}): ${stderr}`);
  }
}

/**
 * Check if a value looks like a script path (ends with .sh, .cmd, .ps1, or .bat).
 */
function isScriptPath(value: string): boolean {
  return /\.(sh|cmd|ps1|bat)$/i.test(value.trim().split(/\s/)[0]);
}

/**
 * Check if a value is an env var reference ($VAR or ${VAR}, entire string).
 * Returns the variable name if matched, null otherwise.
 */
function matchEnvVarRef(value: string): string | null {
  const m = value.trim().match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  return m ? m[1] : null;
}

/**
 * Resolve a single secret value. Supports three modes:
 *
 * 1. **Env var reference** (`$VAR` or `${VAR}`) → resolved from process.env
 * 2. **Script path** (`.sh`, `.cmd`, `.ps1`, `.bat`) → executed, stdout returned
 * 3. **Plain value** (everything else) → returned as-is
 *
 * @param value - The secret value string from the profile
 * @param envVarName - The env var name (for error messages)
 * @returns The resolved secret value
 */
function resolveSecretValue(value: string, envVarName: string): string {
  const logger = getLogger();

  // 1. Env var reference: $VAR or ${VAR}
  const envName = matchEnvVarRef(value);
  if (envName) {
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(
        `Secret "${envVarName}": environment variable "${envName}" is not set`
      );
    }
    logger.debug({ envVar: envVarName, ref: envName }, "Resolved secret from env var");
    return envValue;
  }

  // 2. Script path: has executable extension
  if (isScriptPath(value)) {
    return executeSecretScript(value);
  }

  // 3. Plain value: return as-is
  logger.debug({ envVar: envVarName }, "Using plain secret value");
  return value;
}

/**
 * Resolve all secrets. Each secret value can be:
 *
 * - A **script path** (`~/.heretic/get-key.sh`) → executed, stdout is the value
 * - An **env var reference** (`$MY_TOKEN` or `${MY_TOKEN}`) → resolved from process.env
 * - A **plain value** (`sk-ant-api03-...`) → used as-is
 *
 * @param secrets - Map of env var name to secret source (script, env ref, or plain value)
 * @returns Map of env var name to resolved value
 * @throws Error if any script fails or referenced env var is missing (fail-fast)
 *
 * @example
 * resolveSecrets({
 *   ANTHROPIC_API_KEY: "~/.heretic/get-key.sh",        // script
 *   ZAI_API_KEY: "$ZAI_KEY",                            // env var
 *   CUSTOM_TOKEN: "sk-custom-12345"                     // plain value
 * })
 */
export function resolveSecrets(secrets: SecretsConfig): Record<string, string> {
  const logger = getLogger();
  const resolved: Record<string, string> = {};

  for (const [envVar, value] of Object.entries(secrets)) {
    logger.debug({ envVar, valueType: isScriptPath(value) ? "script" : matchEnvVarRef(value) ? "env" : "plain" }, "Resolving secret");

    resolved[envVar] = resolveSecretValue(value, envVar);

    logger.debug({ envVar }, "Secret resolved successfully");
  }

  return resolved;
}
