import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  validateProfile,
  saveProfile,
  loadProfile,
  listProfiles,
  loadAllProfiles,
  ensureProfilesDir,
  getProfilesDir,
} from "../src/utils/profile-loader";
import type { AgentProfile } from "../src/types/agent-profile";
import { createTestContext } from "./test-helpers";

const ctx = createTestContext("profiles");

describe("Profile Loader", () => {
  // Set up isolated test directory for this test suite
  beforeAll(() => {
    ctx.setup();
    ensureProfilesDir();
  });

  afterAll(() => {
    ctx.teardown();
  });

  // Clean up between tests to avoid state leakage
  afterEach(() => {
    // Clean all yaml files between tests for isolation
    const profilesDir = getProfilesDir();
    if (existsSync(profilesDir)) {
      const files = readdirSync(profilesDir);
      for (const file of files) {
        if (file.endsWith(".yaml")) {
          rmSync(join(profilesDir, file), { force: true });
        }
      }
    }
  });

  describe("validateProfile", () => {
    test("should return error for non-object", () => {
      const errors = validateProfile(null);
      expect(errors).toContain("Profile must be an object");
    });

    test("should return error for missing image field", () => {
      const errors = validateProfile({});
      expect(errors).toContain("Profile missing required field: image");
    });

    test("should return error for missing runner field", () => {
      const errors = validateProfile({ image: "test" });
      expect(errors).toContain("Profile missing required field: runner");
    });

    test("should return error for invalid runner type", () => {
      const errors = validateProfile({ image: "x", runner: "invalid" });
      expect(errors.some((e) => e.includes("runner"))).toBe(true);
    });

    test("should return empty array for valid minimal profile", () => {
      const errors = validateProfile({ image: "test:latest", runner: "docker" });
      expect(errors).toEqual([]);
    });

    test("should validate volumes array", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        volumes: [
          { source: "/src", target: "/dst" },
          { source: "/src2", target: "/dst2", readonly: true },
        ],
      });
      expect(errors).toEqual([]);
    });

    test("should return error for invalid volume", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        volumes: [{ source: "/src" }],
      });
      expect(errors.some((e) => e.includes("volumes[0].target"))).toBe(true);
    });

    test("should validate complete profile", () => {
      const profile: AgentProfile = {
        name: "test",
        description: "Test profile",
        image: "test:latest",
        runner: "docker",
        volumes: [{ source: "/src", target: "/dst" }],
        env: { KEY: "value" },
        workdir: "/app",
        command: ["sh", "-c", "echo test"],
        tty: true,
        interactive: false,
        enabled: true,
        extra: { network: "host" },
      };

      const errors = validateProfile(profile);
      expect(errors).toEqual([]);
    });

    test("should return error for invalid field types", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        workdir: 123,
        tty: "yes",
      });
      expect(errors.some((e) => e.includes("workdir"))).toBe(true);
      expect(errors.some((e) => e.includes("tty"))).toBe(true);
    });

    test("should validate valid ssh config", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        ssh: {
          host: "example.com",
          port: 22,
          user: "agent",
          key_path: "/home/.ssh/id_rsa",
          host_cwd: "/workspace",
        },
      });
      expect(errors).toEqual([]);
    });

    test("should return error for ssh missing host", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        ssh: { port: 22 },
      });
      expect(errors.some((e) => e.includes("ssh.host"))).toBe(true);
    });

    test("should return error for ssh with invalid port type", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        ssh: { host: "example.com", port: "22" },
      });
      expect(errors.some((e) => e.includes("ssh.port"))).toBe(true);
    });

    test("should return error when ssh is not an object", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        ssh: "not-an-object",
      });
      expect(errors.some((e) => e.includes("ssh"))).toBe(true);
    });

    test("should validate valid mcp config", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        mcp: [{ name: "server1", command: "npx", args: ["-y", "pkg"], env: { KEY: "val" } }],
      });
      expect(errors).toEqual([]);
    });

    test("should return error for mcp missing name", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        mcp: [{ command: "npx" }],
      });
      expect(errors.some((e) => e.includes("mcp[0].name"))).toBe(true);
    });

    test("should return error for mcp missing command", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        mcp: [{ name: "server" }],
      });
      expect(errors.some((e) => e.includes("mcp[0].command"))).toBe(true);
    });

    test("should return error when mcp is not an array", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        mcp: "not-an-array",
      });
      expect(errors.some((e) => e.includes("mcp"))).toBe(true);
    });

    test("should return error for mcp with invalid args type", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        mcp: [{ name: "s", command: "c", args: "not-array" }],
      });
      expect(errors.some((e) => e.includes("mcp[0].args"))).toBe(true);
    });

    test("should validate valid git config", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        git: {
          token: "ghp_abc",
          author_name: "Author",
          author_email: "a@b.com",
        },
      });
      expect(errors).toEqual([]);
    });

    test("should return error when git is not an object", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        git: "not-an-object",
      });
      expect(errors.some((e) => e.includes("git"))).toBe(true);
    });

    test("should return error for git with invalid token type", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        git: { token: 123 },
      });
      expect(errors.some((e) => e.includes("git.token"))).toBe(true);
    });

    test("should validate dind as boolean", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        dind: true,
      });
      expect(errors).toEqual([]);
    });

    test("should return error when dind is not a boolean", () => {
      const errors = validateProfile({
        image: "test",
        runner: "docker",
        dind: "yes",
      });
      expect(errors.some((e) => e.includes("dind"))).toBe(true);
    });
  });

  describe("File operations", () => {
    test("saveProfile and loadProfile should work", () => {
      const profile: AgentProfile = {
        image: "test:latest",
        runner: "docker",
        description: "Test profile",
      };

      saveProfile("test-profile", profile);

      const profilePath = join(getProfilesDir(), "test-profile.yaml");
      expect(existsSync(profilePath)).toBe(true);

      const loaded = loadProfile("test-profile");
      expect(loaded.image).toBe("test:latest");
      expect(loaded.runner).toBe("docker");
      expect(loaded.description).toBe("Test profile");
    });

    test("listProfiles should work with test directory", () => {
      saveProfile("alpha", { image: "alpha", runner: "docker" });
      saveProfile("beta", { image: "beta", runner: "docker" });
      saveProfile("gamma", { image: "gamma", runner: "docker" });

      const profiles = listProfiles();
      expect(profiles).toContain("alpha");
      expect(profiles).toContain("beta");
      expect(profiles).toContain("gamma");
    });

    test("should load profile with full configuration", () => {
      const profileData: AgentProfile = {
        name: "full-profile",
        image: "test:latest",
        runner: "compose",
        description: "Full test profile",
        volumes: [{ source: "/src", target: "/dst" }],
        env: { KEY: "value" },
        workdir: "/app",
        tty: true,
      };

      saveProfile("full-profile", profileData);

      const loaded = loadProfile("full-profile");

      expect(loaded.name).toBe("full-profile");
      expect(loaded.image).toBe("test:latest");
      expect(loaded.runner).toBe("compose");
      expect(loaded.volumes).toEqual([{ source: "/src", target: "/dst" }]);
    });
  });

  describe("Integration tests", () => {
    test("getProfilesDir should return test directory path", () => {
      const profilesDir = getProfilesDir();
      expect(profilesDir).toContain("heretic-test-profiles");
      expect(profilesDir).toContain("agents");
    });

    test("ensureProfilesDir should create directory", () => {
      ensureProfilesDir();
      const profilesDir = getProfilesDir();
      expect(existsSync(profilesDir)).toBe(true);
    });

    test("saveProfile and loadProfile integration", () => {
      const profile: AgentProfile = {
        image: "test:latest",
        runner: "docker",
        description: "Temporary test profile",
      };

      saveProfile("integration-test", profile);

      const loaded = loadProfile("integration-test");
      expect(loaded.image).toBe("test:latest");
      expect(loaded.runner).toBe("docker");
      expect(loaded.name).toBe("integration-test");
    });

    test("loadProfile should throw for non-existent profile", () => {
      expect(() => loadProfile(`nonexistent-${Date.now()}`)).toThrow("Profile not found");
    });

    test("listProfiles should return profile names", () => {
      ensureProfilesDir();

      saveProfile("list-test-1", { image: "test1", runner: "docker" });
      saveProfile("list-test-2", { image: "test2", runner: "docker" });

      const profiles = listProfiles();
      expect(Array.isArray(profiles)).toBe(true);
      expect(profiles).toContain("list-test-1");
      expect(profiles).toContain("list-test-2");
    });

    test("loadAllProfiles should return map", () => {
      saveProfile("map-test-1", { image: "test1", runner: "docker" });
      saveProfile("map-test-2", { image: "test2", runner: "compose" });

      const profiles = loadAllProfiles();
      expect(profiles instanceof Map).toBe(true);
      expect(profiles.has("map-test-1")).toBe(true);
      expect(profiles.has("map-test-2")).toBe(true);
      expect(profiles.get("map-test-1")?.image).toBe("test1");
      expect(profiles.get("map-test-2")?.runner).toBe("compose");
    });
  });
});
