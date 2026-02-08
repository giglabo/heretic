import { getLogger } from "../logger";
import {
  hasLocalConfig,
  loadLocalConfig,
  listLocalConfigs,
  resolveConfig,
  validateResolvedConfig,
  stringifyYaml,
  LocalConfigNotFoundError,
  ConfigValidationError,
} from "../utils";

/**
 * Validate a single local profile config.
 * @returns true if valid, false if errors found
 */
function validateSingleProfile(projectDir: string, profileName: string): boolean {
  const logger = getLogger();

  try {
    logger.info(`Validating local config for profile "${profileName}"...`);

    // Step 1: Check if local config exists
    if (!hasLocalConfig(projectDir, profileName)) {
      throw new LocalConfigNotFoundError(projectDir, profileName);
    }

    // Step 2: Load local config
    const localConfig = loadLocalConfig(projectDir, profileName);
    const extendsProfile = localConfig.extends;

    if (!extendsProfile) {
      throw new ConfigValidationError(["Missing 'extends' field in local configuration"]);
    }

    logger.info(`  Extends: ${extendsProfile}`);

    // Step 3: Resolve full config
    const resolved = resolveConfig({
      profileName: extendsProfile,
      projectDir,
    });

    // Step 4: Validate resolved config
    const errors = validateResolvedConfig(resolved);

    if (errors.length > 0) {
      throw new ConfigValidationError(errors);
    }

    // Step 5: Output summary
    logger.info(`  Image: ${resolved.image}`);
    logger.info(`  Runner: ${resolved.runner}`);
    logger.info(`  Volumes: ${resolved.volumes?.length || 0} mount(s)`);
    logger.info(`  Env: ${resolved.env ? Object.keys(resolved.env).length : 0} variable(s)`);

    logger.info("\n✓ All checks passed.\n");

    // Step 6: Show resolved YAML preview
    logger.info("Resolved configuration:");
    logger.info("─".repeat(60));
    logger.info(stringifyYaml(resolved));
    logger.info("─".repeat(60));

    return true;
  } catch (error) {
    if (error instanceof LocalConfigNotFoundError || error instanceof ConfigValidationError) {
      logger.error(error.message);
      if (error.suggestion) {
        logger.info(`💡 ${error.suggestion}`);
      }
    } else if (error instanceof Error) {
      logger.error(`Unexpected error: ${error.message}`);
      logger.info("Run with --verbose for details");
      logger.debug({ error }, "Full error details");
    }
    return false;
  }
}

/**
 * Validates local .heretic/cli/ configurations.
 * If profileName is given, validates just that profile.
 * If omitted, discovers and validates all local profiles.
 */
export async function runLocalValidate(profileName?: string): Promise<void> {
  const logger = getLogger();
  const projectDir = process.cwd();

  if (profileName) {
    // Validate a single named profile
    const valid = validateSingleProfile(projectDir, profileName);
    process.exit(valid ? 0 : 1);
  }

  // Discover and validate all local profiles
  const profiles = listLocalConfigs(projectDir);

  if (profiles.length === 0) {
    logger.error("No local config files found in .heretic/cli/");
    logger.info("Run 'heretic-cli local-init <profile>' to create one.");
    process.exit(1);
  }

  let allValid = true;
  for (const name of profiles) {
    const valid = validateSingleProfile(projectDir, name);
    if (!valid) {
      allValid = false;
    }
  }

  process.exit(allValid ? 0 : 1);
}
