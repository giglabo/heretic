import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { runAgent } from "../src/commands/run-agent";
import { runPs } from "../src/commands/ps";
import { runStop } from "../src/commands/stop";
import { createAgentsCommand } from "../src/commands/agents";
import * as configResolver from "../src/utils/config-resolver";
import * as dockerUtils from "../src/utils/docker";
import * as DockerRunnerModule from "../src/runners/docker-runner";

describe("Agent Commands Integration", () => {
  let resolveConfigSpy: ReturnType<typeof spyOn>;
  let listContainersSpy: ReturnType<typeof spyOn>;
  let stopContainerSpy: ReturnType<typeof spyOn>;
  let removeContainerSpy: ReturnType<typeof spyOn>;
  let dockerRunnerStartSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Mock config resolver
    resolveConfigSpy = spyOn(configResolver, "resolveConfig").mockReturnValue({
      image: "test/image:latest",
      runner: "docker",
      command: ["/bin/bash"],
      workdir: "/app",
      env: { KEY: "value" },
      volumes: [{ source: "/host", target: "/container" }],
    });

    // Mock Docker utilities
    listContainersSpy = spyOn(dockerUtils, "listContainers").mockResolvedValue([
      {
        Id: "abc123",
        Names: ["/heretic-test-agent"],
        Image: "test/image:latest",
        State: "running",
        Status: "Up 5 minutes",
        Labels: {
          "heretic.managed": "true",
          "heretic.agent": "test-agent",
          "heretic.project": "/test/project",
        },
      },
    ]);

    stopContainerSpy = spyOn(dockerUtils, "stopContainer").mockResolvedValue(undefined);
    removeContainerSpy = spyOn(dockerUtils, "removeContainer").mockResolvedValue(undefined);

    // Mock DockerRunner
    dockerRunnerStartSpy = spyOn(
      DockerRunnerModule.DockerRunner.prototype,
      "start"
    ).mockResolvedValue({
      containerId: "abc123",
      agentName: "test-agent",
    });
  });

  afterEach(() => {
    resolveConfigSpy.mockRestore();
    listContainersSpy.mockRestore();
    stopContainerSpy.mockRestore();
    removeContainerSpy.mockRestore();
    dockerRunnerStartSpy.mockRestore();
  });

  describe("run-agent", () => {
    it("calls resolveConfig with correct profileName and CWD", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runAgent("test-profile", { detach: false });
      } catch {
        // Expected to throw due to exit
      }

      expect(resolveConfigSpy).toHaveBeenCalledWith({
        profileName: "test-profile",
        projectDir: process.cwd(),
        cliOverrides: {},
      });

      exitSpy.mockRestore();
    });

    it("creates runner and calls start with detach option", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runAgent("test-profile", { detach: true });
      } catch {
        // Expected to throw due to exit
      }

      expect(dockerRunnerStartSpy).toHaveBeenCalledWith({ detach: true });

      exitSpy.mockRestore();
    });
  });

  describe("ps", () => {
    it("lists containers with heretic labels", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runPs({ json: false });
      } catch {
        // Expected to throw due to exit
      }

      expect(listContainersSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it("outputs JSON format when --json flag is provided", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      try {
        await runPs({ json: true });
      } catch {
        // Expected to throw due to exit
      }

      // Should have called console.log with JSON
      const calls = consoleSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // Verify JSON output
      const jsonOutput = calls[0][0];
      expect(() => JSON.parse(jsonOutput)).not.toThrow();

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it("shows empty state message when no containers", async () => {
      listContainersSpy.mockResolvedValue([]);

      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runPs({ json: false });
      } catch {
        // Expected to throw due to exit
      }

      exitSpy.mockRestore();
    });
  });

  describe("stop", () => {
    it("stops named container", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runStop("heretic-test-agent", {
          all: false,
          force: true,
          keep: false,
        });
      } catch {
        // Expected to throw due to exit
      }

      expect(stopContainerSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it("stops all containers with --all flag", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runStop(undefined, {
          all: true,
          force: true,
          keep: false,
        });
      } catch {
        // Expected to throw due to exit
      }

      expect(listContainersSpy).toHaveBeenCalled();
      expect(stopContainerSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it("removes container when keep is false", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runStop("heretic-test-agent", {
          all: false,
          force: true,
          keep: false,
        });
      } catch {
        // Expected to throw due to exit
      }

      expect(removeContainerSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it("keeps container when keep is true", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runStop("heretic-test-agent", {
          all: false,
          force: true,
          keep: true,
        });
      } catch {
        // Expected to throw due to exit
      }

      expect(stopContainerSpy).toHaveBeenCalled();
      expect(removeContainerSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });

  describe("agents command", () => {
    it("creates agents command group", () => {
      const agentsCmd = createAgentsCommand();

      expect(agentsCmd).toBeDefined();
      expect(agentsCmd.name()).toBe("agents");
    });
  });
});
