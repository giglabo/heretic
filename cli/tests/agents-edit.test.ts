import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { loadProfile, saveProfile, validateProfile } from "../src/utils/profile-loader";
import { getPathProvider } from "../src/utils/profile-paths";
import type { AgentProfile } from "../src/types/agent-profile";
import { createTestContext } from "./test-helpers";

describe("agents edit command", () => {
  const ctx = createTestContext("agents-edit");

  beforeEach(() => {
    ctx.setup();
  });

  afterEach(() => {
    ctx.teardown();
  });

  test("loadProfile should load existing profile", () => {
    const testProfile: AgentProfile = {
      image: "test-image:latest",
      runner: "docker",
      interactive: true,
      tty: true,
      volumes: [
        {
          source: "/host/path",
          target: "/container/path",
          readonly: false,
        },
      ],
      env: {
        TEST_VAR: "test_value",
      },
      workdir: "/workspace",
      command: ["/bin/bash"],
    };

    // Save test profile to actual location
    saveProfile("test-agent", testProfile);

    // Load it back
    const loaded = loadProfile("test-agent");

    expect(loaded.image).toBe("test-image:latest");
    expect(loaded.runner).toBe("docker");
    expect(loaded.interactive).toBe(true);
    expect(loaded.tty).toBe(true);
    expect(loaded.volumes).toHaveLength(1);
    expect(loaded.volumes?.[0].source).toBe("/host/path");
    expect(loaded.env?.TEST_VAR).toBe("test_value");
    expect(loaded.workdir).toBe("/workspace");
  });

  test("loadProfile should throw for non-existent profile", () => {
    expect(() => loadProfile("nonexistent-profile")).toThrow(
      "Profile not found: nonexistent-profile"
    );
  });

  test("saveProfile should save profile correctly", () => {
    const testProfile: AgentProfile = {
      image: "modified-image:latest",
      runner: "docker",
      interactive: false,
      tty: false,
    };

    saveProfile("modified-agent", testProfile);

    // Verify file was created
    const profilePath = join(getPathProvider().getAgentsDir(), "modified-agent.yaml");
    expect(existsSync(profilePath)).toBe(true);

    // Verify content
    const content = readFileSync(profilePath, "utf-8");
    expect(content).toContain("modified-image:latest");
    expect(content).toContain("runner: docker");
  });

  test("profile validation should catch missing required fields", () => {
    const invalidProfile = {
      // Missing 'image' and 'runner'
      interactive: true,
    };

    const errors = validateProfile(invalidProfile);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e: string) => e.includes("image"))).toBe(true);
    expect(errors.some((e: string) => e.includes("runner"))).toBe(true);
  });

  test("profile validation should accept valid profile", () => {
    const validProfile: AgentProfile = {
      image: "test:latest",
      runner: "docker",
      interactive: true,
      tty: true,
    };

    const errors = validateProfile(validProfile);
    expect(errors.length).toBe(0);
  });
});
