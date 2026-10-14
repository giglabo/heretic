import yaml from "js-yaml";
import { readFileSync, writeFileSync } from "fs";

/**
 * Parse YAML string to JavaScript object
 */
export function parseYaml<T = any>(content: string): T {
  try {
    return yaml.load(content) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Convert JavaScript object to YAML string
 */
export function stringifyYaml(data: any, options?: yaml.DumpOptions): string {
  try {
    return yaml.dump(data, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `Failed to stringify YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Read and parse YAML file
 */
export function readYamlFile<T = any>(filePath: string): T {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseYaml<T>(content);
  } catch (error) {
    throw new Error(
      `Failed to read YAML file '${filePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Write JavaScript object to YAML file
 */
export function writeYamlFile(filePath: string, data: any, options?: yaml.DumpOptions): void {
  try {
    const content = stringifyYaml(data, options);
    writeFileSync(filePath, content, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to write YAML file '${filePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate YAML syntax
 */
export function validateYaml(content: string): { valid: boolean; error?: string } {
  try {
    yaml.load(content);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
