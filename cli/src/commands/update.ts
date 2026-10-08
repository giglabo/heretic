import { existsSync } from "node:fs";
import { unlink, rename, chmod, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { version as currentVersion } from "../../package.json";
import { getLogger } from "../logger.js";

const GITHUB_REPO = "giglabo/heretic"; // Update with actual repo
const PENDING_UPDATE_FILE = ".heretic-cli.pending";

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

/**
 * Compares two semantic version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.replace(/^v/, "").split(".").map(Number);
  const bParts = b.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0;
    const bPart = bParts[i] || 0;

    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }

  return 0;
}

/**
 * Checks if a version is newer than another
 */
function isNewerVersion(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

/**
 * Detects the platform-specific asset name
 */
function getPlatformAssetName(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  let platformName: string;
  let archName: string;

  // Map platform
  switch (platform) {
    case "darwin":
      platformName = "darwin";
      break;
    case "linux":
      platformName = "linux";
      break;
    case "win32":
      platformName = "windows";
      break;
    default:
      return null;
  }

  // Map architecture
  switch (arch) {
    case "x64":
      archName = "x64";
      break;
    case "arm64":
      archName = "arm64";
      break;
    default:
      return null;
  }

  // Return the expected asset name pattern
  const extension = platform === "win32" ? ".exe" : "";
  return `heretic-cli-${platformName}-${archName}${extension}`;
}

/**
 * Checks if the executable is in a system directory
 */
function isSystemDirectory(exePath: string): boolean {
  if (process.platform === "win32") {
    // On Windows, check for Program Files and Windows directories
    const systemDirs = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.windir,
      process.env.SystemRoot,
    ].filter(Boolean) as string[];
    return systemDirs.some((dir) => exePath.toLowerCase().startsWith(dir.toLowerCase()));
  }

  // Unix system directories
  const systemDirs = ["/usr/bin", "/usr/local/bin", "/bin", "/sbin", "/usr/sbin", "/opt"];
  return systemDirs.some((dir) => exePath.startsWith(dir));
}

/**
 * Tests if we can write to the directory containing the executable
 */
async function canWriteToDirectory(exePath: string): Promise<boolean> {
  const logger = getLogger();
  const dir = dirname(exePath);

  try {
    // Try to create a temporary test file
    const testFile = resolve(dir, `.heretic-write-test-${Date.now()}`);
    await writeFile(testFile, "");
    await unlink(testFile);
    logger.debug(`Write test successful for directory: ${dir}`);
    return true;
  } catch (error) {
    logger.debug(error, `Write test failed for directory: ${dir}`);
    return false;
  }
}

/**
 * Detects whether the CLI is running from an npm/bun global install
 * (as a JS bundle) rather than a compiled native binary.
 */
function isNpmInstall(): boolean {
  const scriptPath = resolve(process.argv[1]);
  return scriptPath.includes("node_modules") || scriptPath.endsWith(".js");
}

/**
 * Gets the path to the current executable
 */
function getCurrentExecutablePath(): string {
  // process.argv[1] is the path to the script being executed
  // For a bundled executable, this should be the exe path
  return resolve(process.argv[1]);
}

/**
 * Applies a pending update if one exists
 * This should be called at CLI startup
 */
export async function applyPendingUpdate(): Promise<boolean> {
  const logger = getLogger();

  // Skip binary update for npm/bun global installs
  if (isNpmInstall()) {
    logger.debug("Running from npm install, skipping binary pending update check");
    return false;
  }

  const exePath = getCurrentExecutablePath();
  const pendingPath = resolve(dirname(exePath), PENDING_UPDATE_FILE);

  if (!existsSync(pendingPath)) {
    logger.debug("No pending update found");
    return false;
  }

  logger.info("Applying pending update...");

  try {
    // Check if we have write permission
    const canWrite = await canWriteToDirectory(exePath);
    if (!canWrite) {
      logger.error("Cannot apply update: insufficient permissions");
      logger.warn("Please run with sudo or reinstall in a user directory");
      await unlink(pendingPath);
      return false;
    }

    // Backup current executable
    const backupPath = `${exePath}.backup`;
    if (existsSync(backupPath)) {
      await unlink(backupPath);
    }
    await rename(exePath, backupPath);
    logger.debug(`Backed up current executable to: ${backupPath}`);

    // Move pending update to replace current executable
    await rename(pendingPath, exePath);
    await chmod(exePath, 0o755);
    logger.info("Update applied successfully!");

    // Clean up backup after successful update
    try {
      await unlink(backupPath);
      logger.debug("Cleaned up backup file");
    } catch (error) {
      logger.debug(error, "Could not clean up backup file");
    }

    return true;
  } catch (error) {
    logger.error(error, "Failed to apply pending update:");

    // Try to restore from backup if it exists
    const backupPath = `${exePath}.backup`;
    if (existsSync(backupPath)) {
      try {
        await rename(backupPath, exePath);
        logger.info("Restored from backup");
      } catch (restoreError) {
        logger.error(restoreError, "Failed to restore from backup:");
      }
    }

    // Clean up pending file
    try {
      if (existsSync(pendingPath)) {
        await unlink(pendingPath);
      }
    } catch (cleanupError) {
      logger.debug(cleanupError, "Could not clean up pending file");
    }

    return false;
  }
}

/**
 * Fetches the latest release information from GitHub
 */
async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const logger = getLogger();
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

  try {
    logger.debug(`Fetching latest release from: ${url}`);
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "heretic-cli",
      },
    });

    if (!response.ok) {
      logger.error(`GitHub API returned status ${response.status}`);
      return null;
    }

    const data = (await response.json()) as GitHubRelease;
    logger.debug(`Latest release: ${data.tag_name}`);
    return data;
  } catch (error) {
    logger.error(error, "Failed to fetch latest release:");
    return null;
  }
}

/**
 * Downloads the update and stages it for application on next restart
 */
async function downloadAndStage(downloadUrl: string, exePath: string): Promise<boolean> {
  const logger = getLogger();
  const pendingPath = resolve(dirname(exePath), PENDING_UPDATE_FILE);

  try {
    logger.info("Downloading update...");
    logger.debug(`Download URL: ${downloadUrl}`);

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      logger.error(`Download failed with status ${response.status}`);
      return false;
    }

    const buffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);

    logger.debug(`Downloaded ${uint8Array.length} bytes`);
    logger.debug(`Staging update to: ${pendingPath}`);

    // Write to pending file
    await writeFile(pendingPath, uint8Array);
    await chmod(pendingPath, 0o755);

    logger.info("Update staged successfully!");
    logger.info("Restart the CLI to apply the update");
    return true;
  } catch (error) {
    logger.error(error, "Failed to download and stage update:");

    // Clean up partial download
    try {
      if (existsSync(pendingPath)) {
        await unlink(pendingPath);
      }
    } catch (cleanupError) {
      logger.debug(cleanupError, "Could not clean up pending file");
    }

    return false;
  }
}

/**
 * Main update function
 * Checks for updates and stages them for application on restart
 */
export async function runUpdate(_args: string[] = []): Promise<void> {
  const logger = getLogger();
  // const checkOnly = _args.includes('--check');

  logger.info("Checking for updates...");
  logger.debug(`Current version: ${currentVersion}`);

  // For npm/bun global installs, redirect to package manager update
  if (isNpmInstall()) {
    logger.info(`Current version: ${currentVersion}`);
    logger.info("This CLI was installed via npm/bun. To update, run:");
    logger.info("");
    logger.info("  bun update -g heretic-cli");
    logger.info("");
    return;
  }

  // Get current executable path
  const exePath = getCurrentExecutablePath();
  logger.debug(`Executable path: ${exePath}`);

  // Check if we're in a system directory
  if (isSystemDirectory(exePath)) {
    logger.warn("CLI is installed in a system directory");
    const canWrite = await canWriteToDirectory(exePath);
    if (!canWrite) {
      logger.error("Cannot update: insufficient permissions");
      logger.warn("Please run with sudo or reinstall in a user directory (e.g., ~/.local/bin)");
      return;
    }
  }

  // Fetch latest release
  const release = await fetchLatestRelease();
  if (!release) {
    logger.error("Could not fetch latest release information");
    return;
  }

  // Compare versions
  const remoteVersion = release.tag_name;
  logger.debug(`Remote version: ${remoteVersion}`);

  if (!isNewerVersion(remoteVersion, currentVersion)) {
    logger.info("You are already on the latest version!");
    return;
  }

  logger.info(`New version available: ${remoteVersion} (current: ${currentVersion})`);

  // Find the appropriate asset for this platform
  const assetName = getPlatformAssetName();
  if (!assetName) {
    logger.error(`Unsupported platform: ${process.platform} ${process.arch}`);
    return;
  }

  logger.debug(`Looking for asset: ${assetName}`);
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    logger.error(`Could not find asset for ${assetName}`);
    logger.debug(`Available assets: ${release.assets.map((a) => a.name).join(", ")}`);
    return;
  }

  // Download and stage the update
  const success = await downloadAndStage(asset.browser_download_url, exePath);
  if (success) {
    logger.info("");
    logger.info("Update downloaded and staged successfully!");
    logger.info("Run any heretic-cli command to apply the update");
  }
}
