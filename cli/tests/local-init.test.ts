import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { runLocalInit } from "../src/commands/localInit";
import { getLocalConfigPath, getLocalComposePath } from "../src/utils/local-config";
import { writeYamlFile } from "../src/utils/yaml";
import { getPathProvider } from "../src/utils/profile-paths";
import { createTestContext } from "./test-helpers";

const TEST_PROFILE = "test-profile-local-init";

describe("local-init command", () => {
  const testDir = join(__dirname, ".test-local-init");
  const originalCwd = process.cwd();
  const ctx = createTestContext("local-init");

  let profilesDir: string;
  let testProfilePath: string;

  beforeEach(() => {
    // Set up path provider first
    ctx.setup();

    // Now resolve paths after the provider is configured
    profilesDir = getPathProvider().getAgentsDir();
    testProfilePath = join(profilesDir, `${TEST_PROFILE}.yaml`);

    // Create test directory and change to it
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Create test profile
    const testProfile = {
      image: "test/image:latest",
      runner: "docker" as const,
      volumes: [
        {
          source: "${CWD}",
          target: "/workspace",
          readonly: false,
        },
      ],
      env: {
        TEST_VAR: "value",
      },
      workdir: "/workspace",
      interactive: true,
      tty: true,
    };

    writeYamlFile(testProfilePath, testProfile);
  });

  afterEach(() => {
    // Restore original cwd
    process.chdir(originalCwd);

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Clean up path provider and its temp dir
    ctx.teardown();
  });

  describe("per-profile config mode", () => {
    test("should create per-profile yaml with specified profile", async () => {
      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      expect(existsSync(configPath)).toBe(true);

      const fileContent = readFileSync(configPath, "utf-8");
      expect(fileContent).toContain(`# Local agent configuration for ${TEST_PROFILE}`);
    });

    test("should refuse to overwrite existing file without --force", async () => {
      // Create file first
      await runLocalInit(TEST_PROFILE, {});

      const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      // Try to create again without --force
      await expect(runLocalInit(TEST_PROFILE, {})).rejects.toThrow("process.exit");

      exitSpy.mockRestore();
    });

    test("should overwrite existing file with --force", async () => {
      // Create file first
      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      expect(existsSync(configPath)).toBe(true);

      // Create again with --force - should not throw
      await runLocalInit(TEST_PROFILE, { force: true });

      // File should still exist
      expect(existsSync(configPath)).toBe(true);
    });

    test("should create .heretic/cli directory if it doesn't exist", async () => {
      const hereticCliDir = join(testDir, ".heretic", "cli");
      expect(existsSync(hereticCliDir)).toBe(false);

      await runLocalInit(TEST_PROFILE, {});

      expect(existsSync(hereticCliDir)).toBe(true);
    });

    test("should error for non-existent profile", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(runLocalInit("non-existent-profile-xyz", {})).rejects.toThrow("process.exit");

      exitSpy.mockRestore();
    });

    test("generated config should contain helpful comments", async () => {
      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      const fileContent = readFileSync(configPath, "utf-8");

      expect(fileContent).toContain(`# Local agent configuration for ${TEST_PROFILE}`);
      expect(fileContent).toContain("# Override environment variables");
      expect(fileContent).toContain("# Override volumes");
    });

    test("generated config should contain new feature comments", async () => {
      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      const fileContent = readFileSync(configPath, "utf-8");

      expect(fileContent).toContain("# SSH backend configuration");
      expect(fileContent).toContain("# MCP server configurations");
      expect(fileContent).toContain("# Git configuration");
      expect(fileContent).toContain("# dind: false");
    });

    test("should create .heretic/temp/ directory", async () => {
      await runLocalInit(TEST_PROFILE, {});

      const tempDir = join(testDir, ".heretic", "temp");
      expect(existsSync(tempDir)).toBe(true);
    });

    test("should create claude-settings.json with correct content", async () => {
      await runLocalInit(TEST_PROFILE, {});

      const settingsPath = join(testDir, ".heretic", "cli", "claude-settings.json");
      expect(existsSync(settingsPath)).toBe(true);

      const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(content.dangerouslySkipPermissions).toBe(true);
      expect(content.enabledMcpjsonServers).toEqual([]);
      expect(content.allowedTools).toContain("Bash");
      expect(content.allowedTools).toContain("Edit");
    });

    test("should not overwrite existing claude-settings.json without --force", async () => {
      // Create first
      await runLocalInit(TEST_PROFILE, {});

      const settingsPath = join(testDir, ".heretic", "cli", "claude-settings.json");

      // Modify the file
      writeFileSync(settingsPath, JSON.stringify({ custom: true }), "utf-8");

      // Run again with --force
      await runLocalInit(TEST_PROFILE, { force: true });

      // claude-settings.json should be overwritten with --force
      const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(content.dangerouslySkipPermissions).toBe(true);
    });

    test("should allow creating configs for two different profiles", async () => {
      // Create a second test profile
      const secondProfilePath = join(profilesDir, "second-profile.yaml");
      writeYamlFile(secondProfilePath, {
        image: "second/image:latest",
        runner: "docker",
      });

      await runLocalInit(TEST_PROFILE, {});
      await runLocalInit("second-profile", {});

      // Both per-profile files should exist
      expect(existsSync(getLocalConfigPath(testDir, TEST_PROFILE))).toBe(true);
      expect(existsSync(getLocalConfigPath(testDir, "second-profile"))).toBe(true);
    });
  });

  describe("compose.yaml mode", () => {
    test("should create .heretic/compose.yaml with --compose flag", async () => {
      await runLocalInit(undefined, { compose: true });

      const composePath = getLocalComposePath(testDir);
      expect(existsSync(composePath)).toBe(true);

      const content = readFileSync(composePath, "utf-8");
      expect(content).toContain("version:");
      expect(content).toContain("services:");
      expect(content).toContain("agent:");
    });

    test("should refuse to overwrite existing compose.yaml without --force", async () => {
      // Create compose.yaml first
      await runLocalInit(undefined, { compose: true });

      const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });

      // Try to create again without --force
      await expect(runLocalInit(undefined, { compose: true })).rejects.toThrow("process.exit");

      exitSpy.mockRestore();
    });

    test("should overwrite existing compose.yaml with --force", async () => {
      // Create compose.yaml first
      await runLocalInit(undefined, { compose: true });

      // Create again with --force - should not throw
      await runLocalInit(undefined, { compose: true, force: true });

      const composePath = getLocalComposePath(testDir);
      expect(existsSync(composePath)).toBe(true);
    });

    test("generated compose.yaml should contain helpful comments", async () => {
      await runLocalInit(undefined, { compose: true });

      const composePath = getLocalComposePath(testDir);
      const content = readFileSync(composePath, "utf-8");

      expect(content).toContain("# Custom Docker Compose configuration");
      expect(content).toContain("# Add additional services as needed");
    });
  });

  describe("gitignore handling", () => {
    test("should not crash when .gitignore doesn't exist", async () => {
      // Just verify it doesn't throw
      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      expect(existsSync(configPath)).toBe(true);
    });

    test("should work when .gitignore exists", async () => {
      // Create .gitignore
      writeFileSync(join(testDir, ".gitignore"), "node_modules/\n");

      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      expect(existsSync(configPath)).toBe(true);
    });

    test("should work when .heretic/ is already in .gitignore", async () => {
      // Create .gitignore with .heretic/
      writeFileSync(join(testDir, ".gitignore"), "node_modules/\n.heretic/\n");

      await runLocalInit(TEST_PROFILE, {});

      const configPath = getLocalConfigPath(testDir, TEST_PROFILE);
      expect(existsSync(configPath)).toBe(true);
    });
  });
});
