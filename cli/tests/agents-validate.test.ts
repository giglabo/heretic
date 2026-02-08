import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { validateAgents } from "../src/commands/agents";
import * as profileLoader from "../src/utils/profile-loader";
import * as fs from "fs";

describe("agents validate", () => {
  let logOutput: string[] = [];
  let mocks: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    logOutput = [];
    mocks = [];
    mocks.push(
      spyOn(console, "log").mockImplementation((msg: string) => {
        logOutput.push(msg);
      })
    );
  });

  afterEach(() => {
    // Restore all mocks
    mocks.forEach((m) => m.mockRestore());
    mocks = [];
    logOutput = [];
  });

  test("validates a single valid profile", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));
    mocks.push(
      spyOn(fs, "readFileSync").mockReturnValue(
        `image: test:latest
runner: docker
volumes:
  - source: /host
    target: /container
env:
  KEY: value
`
      )
    );
    mocks.push(
      spyOn(profileLoader, "validateProfileDetailed").mockReturnValue({
        errors: [],
        warnings: [],
      })
    );

    await validateAgents("test");

    const output = logOutput.join("\n");
    expect(output).toContain('Validating profile "test"');
    expect(output).toContain("[pass] YAML syntax");
    expect(output).toContain("[pass] Required fields");
  });

  test("reports YAML syntax errors", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));
    mocks.push(
      spyOn(fs, "readFileSync").mockReturnValue(
        `image: test:latest
invalid yaml: [
`
      )
    );

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`Process.exit(${code})`);
    });
    mocks.push(exitSpy);

    try {
      await validateAgents("test");
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toEqual(new Error("Process.exit(1)"));
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logOutput.join("\n");
    expect(output).toContain("[fail] YAML syntax");
  });

  test("reports missing required fields", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));
    mocks.push(
      spyOn(fs, "readFileSync").mockReturnValue(
        `runner: docker
`
      )
    );
    mocks.push(
      spyOn(profileLoader, "validateProfileDetailed").mockReturnValue({
        errors: ["Profile missing required field: image"],
        warnings: [],
      })
    );

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`Process.exit(${code})`);
    });
    mocks.push(exitSpy);

    try {
      await validateAgents("test");
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toEqual(new Error("Process.exit(1)"));
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logOutput.join("\n");
    expect(output).toContain("[fail] Required fields");
  });

  test("reports invalid port format", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));
    mocks.push(
      spyOn(fs, "readFileSync").mockReturnValue(
        `image: test:latest
runner: docker
extra:
  ports:
    - "invalid"
`
      )
    );
    mocks.push(
      spyOn(profileLoader, "validateProfileDetailed").mockReturnValue({
        errors: [
          "Invalid port mapping format: invalid. Must be host:container or host:container/protocol",
        ],
        warnings: [],
      })
    );

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`Process.exit(${code})`);
    });
    mocks.push(exitSpy);

    try {
      await validateAgents("test");
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toEqual(new Error("Process.exit(1)"));
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logOutput.join("\n");
    expect(output).toContain("[fail]");
  });

  test("warns about compose section when runner is not compose", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));
    mocks.push(
      spyOn(fs, "readFileSync").mockReturnValue(
        `image: test:latest
runner: docker
compose:
  services:
    db:
      image: postgres:16
`
      )
    );
    mocks.push(
      spyOn(profileLoader, "validateProfileDetailed").mockReturnValue({
        errors: [],
        warnings: ['compose section present but runner is "docker". Compose config will be ignored.'],
      })
    );

    await validateAgents("test");

    const output = logOutput.join("\n");
    expect(output).toContain("[warn]");
    expect(output).toContain("compose section");
  });

  test("reports profile not found", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(false));

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`Process.exit(${code})`);
    });
    mocks.push(exitSpy);

    try {
      await validateAgents("nonexistent");
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toEqual(new Error("Process.exit(1)"));
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("validates all profiles when no name is provided", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(profileLoader, "listProfiles").mockReturnValue(["profile1", "profile2"]));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));

    let callCount = 0;
    mocks.push(
      spyOn(fs, "readFileSync").mockImplementation(() => {
        callCount++;
        return callCount === 1
          ? `image: test1:latest\nrunner: docker\n`
          : `image: test2:latest\nrunner: compose\n`;
      })
    );

    mocks.push(
      spyOn(profileLoader, "validateProfileDetailed").mockReturnValue({
        errors: [],
        warnings: [],
      })
    );

    await validateAgents();

    const output = logOutput.join("\n");
    expect(output).toContain('Validating profile "profile1"');
    expect(output).toContain('Validating profile "profile2"');
  });

  test("validates port format with protocol", async () => {
    mocks.push(spyOn(profileLoader, "getProfilesDir").mockReturnValue("/fake/path"));
    mocks.push(spyOn(fs, "existsSync").mockReturnValue(true));
    mocks.push(
      spyOn(fs, "readFileSync").mockReturnValue(
        `image: test:latest
runner: docker
extra:
  ports:
    - "8080:80"
    - "3000:3000/tcp"
`
      )
    );
    mocks.push(
      spyOn(profileLoader, "validateProfileDetailed").mockReturnValue({
        errors: [],
        warnings: [],
      })
    );

    await validateAgents("test");

    const output = logOutput.join("\n");
    expect(output).toContain("[pass]");
  });
});
