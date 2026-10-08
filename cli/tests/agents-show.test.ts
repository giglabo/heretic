import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { showAgent } from "../src/commands/agents";
import * as profileLoader from "../src/utils/profile-loader";
import * as configResolver from "../src/utils/config-resolver";
import type { AgentProfile, ResolvedAgentConfig } from "../src/types/agent-profile";

describe("agents show", () => {
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
    mocks.forEach((m) => m.mockRestore());
    mocks = [];
    logOutput = [];
  });

  test("shows raw profile with masked sensitive env vars", async () => {
    const mockProfile: AgentProfile = {
      image: "test-image:latest",
      runner: "docker",
      volumes: [
        {
          source: "${CWD}",
          target: "/workspace",
        },
      ],
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz",
        TERM: "xterm-256color",
        MY_SECRET: "supersecret123",
        NORMAL_VAR: "normalvalue",
      },
      workdir: "/workspace",
      interactive: true,
      tty: true,
    };

    mocks.push(spyOn(profileLoader, "loadProfile").mockReturnValue(mockProfile));

    await showAgent("test", { resolved: false, reveal: false });

    const output = logOutput.join("");

    // Check that the output contains the profile data
    expect(output).toContain("image: test-image:latest");
    expect(output).toContain("runner: docker");

    // Check that sensitive values are masked
    expect(output).toContain("ANTHROPIC_API_KEY: sk-ant-a****wxyz");
    expect(output).toContain("MY_SECRET: supersec****t123"); // 8 chars + **** + 4 chars

    // Check that normal values are not masked
    expect(output).toContain("TERM: xterm-256color");
    expect(output).toContain("NORMAL_VAR: normalvalue");

    // Should NOT contain the actual sensitive values
    expect(output).not.toContain("sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("supersecret123");
  });

  test("shows raw profile with revealed sensitive values when --reveal is set", async () => {
    const mockProfile: AgentProfile = {
      image: "test-image:latest",
      runner: "docker",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-secret",
        MY_TOKEN: "token123",
      },
    };

    mocks.push(spyOn(profileLoader, "loadProfile").mockReturnValue(mockProfile));

    await showAgent("test", { resolved: false, reveal: true });

    const output = logOutput.join("");

    // Check that actual values are shown
    expect(output).toContain("ANTHROPIC_API_KEY: sk-ant-api03-secret");
    expect(output).toContain("MY_TOKEN: token123");
  });

  test("shows resolved config with interpolated values when --resolved is set", async () => {
    const mockProfile: AgentProfile = {
      image: "test-image:latest",
      runner: "docker",
      volumes: [
        {
          source: "${CWD}",
          target: "/workspace",
        },
      ],
      env: {
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        TERM: "xterm-256color",
      },
      workdir: "/workspace",
      interactive: true,
      tty: true,
    };

    const mockResolved: ResolvedAgentConfig = {
      name: "test",
      projectDir: "/home/user/project",
      image: "test-image:latest",
      runner: "docker",
      volumes: [
        {
          source: "/home/user/project",
          target: "/workspace",
          readonly: false,
        },
      ],
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-actual-key-value",
        TERM: "xterm-256color",
      },
      workdir: "/workspace",
      command: [],
      interactive: true,
      tty: true,
      extra: {},
    };

    mocks.push(spyOn(profileLoader, "loadProfile").mockReturnValue(mockProfile));
    mocks.push(spyOn(configResolver, "resolveConfig").mockReturnValue(mockResolved));

    await showAgent("test", { resolved: true, reveal: false });

    const output = logOutput.join("");

    // Check that interpolated values are shown
    expect(output).toContain("source: /home/user/project");

    // Check that sensitive values are still masked in resolved mode
    expect(output).toContain("ANTHROPIC_API_KEY: sk-ant-a****alue");

    // Normal values should be shown as-is
    expect(output).toContain("TERM: xterm-256color");
  });

  test("shows resolved config with revealed sensitive values when both flags are set", async () => {
    const mockProfile: AgentProfile = {
      image: "test-image:latest",
      runner: "docker",
      env: {
        MY_PASSWORD: "${MY_PASSWORD}",
      },
    };

    const mockResolved: ResolvedAgentConfig = {
      name: "test",
      projectDir: "/home/user/project",
      image: "test-image:latest",
      runner: "docker",
      volumes: [],
      env: {
        MY_PASSWORD: "actual-password-123",
      },
      workdir: "",
      command: [],
      interactive: true,
      tty: true,
      extra: {},
    };

    mocks.push(spyOn(profileLoader, "loadProfile").mockReturnValue(mockProfile));
    mocks.push(spyOn(configResolver, "resolveConfig").mockReturnValue(mockResolved));

    await showAgent("test", { resolved: true, reveal: true });

    const output = logOutput.join("");

    // Check that actual value is shown (not masked)
    expect(output).toContain("MY_PASSWORD: actual-password-123");
  });

  test("exits with error when profile not found", async () => {
    mocks.push(
      spyOn(profileLoader, "loadProfile").mockImplementation(() => {
        throw new Error("Profile not found: nonexistent");
      })
    );

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`Process.exit(${code})`);
    });
    mocks.push(exitSpy);

    try {
      await showAgent("nonexistent", { resolved: false, reveal: false });
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toEqual(new Error("Process.exit(1)"));
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("masks various sensitive key patterns", async () => {
    const mockProfile: AgentProfile = {
      image: "test-image:latest",
      runner: "docker",
      env: {
        API_KEY: "key123456789012",
        AUTH_TOKEN: "token123456789",
        DB_PASSWORD: "pass123456789",
        MY_SECRET: "secret123456789",
        SOME_API_KEY: "apikey1234567",
        OAUTH_TOKEN: "oauth123456789",
        NORMAL_VALUE: "not-sensitive",
      },
    };

    mocks.push(spyOn(profileLoader, "loadProfile").mockReturnValue(mockProfile));

    await showAgent("test", { resolved: false, reveal: false });

    const output = logOutput.join("");

    // All sensitive patterns should be masked
    expect(output).toContain("API_KEY:");
    expect(output).not.toContain("key123456789012");

    expect(output).toContain("AUTH_TOKEN:");
    expect(output).not.toContain("token123456789");

    expect(output).toContain("DB_PASSWORD:");
    expect(output).not.toContain("pass123456789");

    expect(output).toContain("MY_SECRET:");
    expect(output).not.toContain("secret123456789");

    // Normal value should NOT be masked
    expect(output).toContain("NORMAL_VALUE: not-sensitive");
  });
});
