import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getLogger } from "../logger";
import { getPathProvider } from "../utils/profile-paths";
import {
  isDockerAvailable,
  getDockerVersion,
  listImages,
  pullImage,
  loadAllProfiles,
  validateProfile,
  listLocalConfigs,
  resolveConfig,
  validateResolvedConfig,
  loadSettings,
} from "../utils";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
}

/**
 * Runs comprehensive environment checks for Heretic CLI.
 * Validates Docker, configuration, profiles, and optionally fixes issues.
 */
export async function runDoctor(options: { fix?: boolean } = {}): Promise<void> {
  const logger = getLogger();
  const results: CheckResult[] = [];

  logger.info("Running environment checks...\n");

  // Check 1: Docker daemon
  try {
    const available = await isDockerAvailable();
    if (available) {
      results.push({
        name: "Docker daemon",
        status: "pass",
        message: "Docker daemon is running",
      });
    } else {
      results.push({
        name: "Docker daemon",
        status: "fail",
        message: "Docker daemon is not running",
      });
    }
  } catch (error) {
    results.push({
      name: "Docker daemon",
      status: "fail",
      message: `Failed to check Docker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Check 2: Docker version
  try {
    const version = await getDockerVersion();
    const apiVersion = parseFloat(version.ApiVersion);
    if (apiVersion >= 1.41) {
      results.push({
        name: "Docker version",
        status: "pass",
        message: `Docker version ${version.Version} (API ${version.ApiVersion})`,
      });
    } else {
      results.push({
        name: "Docker version",
        status: "fail",
        message: `Docker API version ${version.ApiVersion} is too old (minimum: 1.41)`,
      });
    }
  } catch (error) {
    results.push({
      name: "Docker version",
      status: "fail",
      message: `Failed to get Docker version: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Check 3: Docker Compose
  try {
    const proc = Bun.spawn(["docker", "compose", "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      results.push({
        name: "Docker Compose",
        status: "pass",
        message: "Docker Compose is available",
      });
    } else {
      results.push({
        name: "Docker Compose",
        status: "warn",
        message: "Docker Compose not available (optional for most operations)",
      });
    }
  } catch (_error) {
    results.push({
      name: "Docker Compose",
      status: "warn",
      message: "Docker Compose not available (optional for most operations)",
    });
  }

  // Check 4: Config directory
  const configDir = getPathProvider().getHereticDir();
  if (existsSync(configDir)) {
    results.push({
      name: "Config directory",
      status: "pass",
      message: `${configDir} exists`,
    });
  } else {
    if (options.fix) {
      try {
        mkdirSync(configDir, { recursive: true });
        results.push({
          name: "Config directory",
          status: "pass",
          message: `Created ${configDir}`,
        });
      } catch (error) {
        results.push({
          name: "Config directory",
          status: "warn",
          message: `Failed to create ${configDir}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      results.push({
        name: "Config directory",
        status: "warn",
        message: `${configDir} does not exist (use --fix to create)`,
      });
    }
  }

  // Check 5: Settings file
  const settingsFile = join(configDir, "settings.yaml");
  try {
    loadSettings();
    results.push({
      name: "Settings file",
      status: "pass",
      message: `${settingsFile} is valid`,
    });
  } catch (_error) {
    results.push({
      name: "Settings file",
      status: "warn",
      message: `${settingsFile} missing or invalid (will use defaults)`,
    });
  }

  // Check 6: Global profiles
  try {
    const profiles = loadAllProfiles();
    let allValid = true;
    const invalidProfiles: string[] = [];

    for (const [name, profile] of Object.entries(profiles)) {
      const errors = validateProfile(profile);
      if (errors.length > 0) {
        allValid = false;
        invalidProfiles.push(`${name}: ${errors.join(", ")}`);
      }
    }

    if (allValid) {
      results.push({
        name: "Global profiles",
        status: "pass",
        message: `${Object.keys(profiles).length} profile(s) validated`,
      });
    } else {
      results.push({
        name: "Global profiles",
        status: "fail",
        message: `Invalid profiles found:\n    ${invalidProfiles.join("\n    ")}`,
      });
    }
  } catch (error) {
    results.push({
      name: "Global profiles",
      status: "fail",
      message: `Failed to load profiles: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Check 7: Local configs (per-profile)
  const projectDir = process.cwd();
  const localProfiles = listLocalConfigs(projectDir);
  if (localProfiles.length > 0) {
    let allLocalValid = true;
    const localErrors: string[] = [];

    for (const profileName of localProfiles) {
      try {
        const resolved = resolveConfig({ profileName, projectDir });
        const errors = validateResolvedConfig(resolved);
        if (errors.length > 0) {
          allLocalValid = false;
          localErrors.push(`${profileName}: ${errors.join(", ")}`);
        }
      } catch (error) {
        allLocalValid = false;
        localErrors.push(
          `${profileName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (allLocalValid) {
      results.push({
        name: "Local config",
        status: "pass",
        message: `${localProfiles.length} local config(s) valid: ${localProfiles.join(", ")}`,
      });
    } else {
      results.push({
        name: "Local config",
        status: "fail",
        message: `Local config validation failed:\n    ${localErrors.join("\n    ")}`,
      });
    }
  } else {
    results.push({
      name: "Local config",
      status: "skip",
      message: "No local config in current directory",
    });
  }

  // Check 8: Required images
  try {
    const profiles = loadAllProfiles();
    const requiredImages = new Set<string>();
    for (const profile of Object.values(profiles)) {
      if (profile.image) {
        requiredImages.add(profile.image);
      }
    }

    const availableImages = await listImages();
    const availableImageNames = new Set(availableImages.flatMap((img) => img.RepoTags || []));

    const missingImages = Array.from(requiredImages).filter((img) => !availableImageNames.has(img));

    if (missingImages.length === 0) {
      results.push({
        name: "Required images",
        status: "pass",
        message: "All required images are available",
      });
    } else {
      if (options.fix) {
        logger.info(`Pulling ${missingImages.length} missing image(s)...`);
        let allPulled = true;
        for (const image of missingImages) {
          try {
            await pullImage(image);
            logger.info(`  ✓ Pulled ${image}`);
          } catch (error) {
            logger.warn(
              `  ✗ Failed to pull ${image}: ${error instanceof Error ? error.message : String(error)}`
            );
            allPulled = false;
          }
        }
        if (allPulled) {
          results.push({
            name: "Required images",
            status: "pass",
            message: `Pulled ${missingImages.length} missing image(s)`,
          });
        } else {
          results.push({
            name: "Required images",
            status: "warn",
            message: "Some images failed to pull",
          });
        }
      } else {
        results.push({
          name: "Required images",
          status: "warn",
          message: `Missing ${missingImages.length} image(s): ${missingImages.join(", ")} (use --fix to pull)`,
        });
      }
    }
  } catch (error) {
    results.push({
      name: "Required images",
      status: "warn",
      message: `Failed to check images: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Check 9: Network connectivity
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://registry-1.docker.io/v2/", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok || response.status === 401) {
      // 401 is expected for unauthenticated requests
      results.push({
        name: "Network connectivity",
        status: "pass",
        message: "Docker Hub is reachable",
      });
    } else {
      results.push({
        name: "Network connectivity",
        status: "warn",
        message: `Docker Hub returned status ${response.status}`,
      });
    }
  } catch (_error) {
    results.push({
      name: "Network connectivity",
      status: "warn",
      message: "Unable to reach Docker Hub (may affect image pulls)",
    });
  }

  // Check 10: Volume paths
  try {
    const profiles = loadAllProfiles();
    const invalidPaths: string[] = [];

    for (const [name, profile] of Object.entries(profiles)) {
      if (profile.volumes) {
        for (const volume of profile.volumes) {
          if (volume.source && !volume.source.startsWith("${")) {
            // Skip variable-based paths
            if (!existsSync(volume.source)) {
              invalidPaths.push(`${name}: ${volume.source}`);
            }
          }
        }
      }
    }

    // Also check local configs if present
    for (const profileName of localProfiles) {
      try {
        const resolved = resolveConfig({ profileName, projectDir });
        if (resolved.volumes) {
          for (const volume of resolved.volumes) {
            if (volume.source && !existsSync(volume.source)) {
              invalidPaths.push(`${profileName} (local): ${volume.source}`);
            }
          }
        }
      } catch {
        // Already reported in check 7
      }
    }

    if (invalidPaths.length === 0) {
      results.push({
        name: "Volume paths",
        status: "pass",
        message: "All volume source paths exist",
      });
    } else {
      results.push({
        name: "Volume paths",
        status: "warn",
        message: `Non-existent paths found:\n    ${invalidPaths.join("\n    ")}`,
      });
    }
  } catch (error) {
    results.push({
      name: "Volume paths",
      status: "warn",
      message: `Failed to check volume paths: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Print results
  logger.info("");
  for (const result of results) {
    const symbol = {
      pass: "[pass]",
      warn: "[warn]",
      fail: "[fail]",
      skip: "[skip]",
    }[result.status];

    logger.info(`${symbol} ${result.message}`);
  }

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  logger.info(`\nSummary: ${passed} passed, ${warnings} warnings, ${failed} failed`);

  // Exit code
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}
