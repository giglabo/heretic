import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { runAgent } from "../src/commands/run-agent";
import { runPs } from "../src/commands/ps";
import { runStop } from "../src/commands/stop";
import { createAgentsCommand } from "../src/commands/agents";
import * as configResolver from "../src/utils/config-resolver";
import * as dockerUtils from "../src/utils/docker";
import * as DockerRunnerModule from "../src/runners/docker-runner";
import * as containerReuse from "../src/utils/container-reuse";
import { getAgentContainerName } from "../src/utils/session";

describe("Agent Commands Integration", () => {
  let resolveConfigSpy: ReturnType<typeof spyOn>;
  let listContainersSpy: ReturnType<typeof spyOn>;
  let stopContainerSpy: ReturnType<typeof spyOn>;
  let removeContainerSpy: ReturnType<typeof spyOn>;
  let dockerRunnerStartSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Mock config resolver
    resolveConfigSpy = spyOn(configResolver, "resolveConfig").mockReturnValue({
      name: "test-profile",
      sessionName: "default",
      projectDir: "/test/project",
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
    // run-agent reports failures via process.exitCode; don't let a test that
    // expects a refusal fail the whole `bun test` run.
    process.exitCode = 0;
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

      expect(dockerRunnerStartSpy).toHaveBeenCalledWith(
        expect.objectContaining({ detach: true, recreate: false })
      );

      exitSpy.mockRestore();
    });

    const sessionName = getAgentContainerName("test-profile", "default", "/test/project");
    const ownLabels = {
      "heretic.managed": "true",
      "heretic.agent": "test-profile",
      "heretic.project": "/test/project",
      "heretic.session": "default",
    };
    const liveSession = (labels: Record<string, string> = ownLabels): ReturnType<typeof spyOn> =>
      spyOn(dockerUtils, "findContainerByName").mockResolvedValue({
        Id: "live123",
        Names: [`/${sessionName}`],
        State: "running",
        Labels: labels,
      } as any);

    it("attaches to the running session instead of starting another one", async () => {
      const findSpy = liveSession();
      const attachSpy = spyOn(containerReuse, "attachToContainer").mockResolvedValue(undefined);

      try {
        await runAgent("test-profile", {});

        expect(findSpy).toHaveBeenCalledWith(sessionName);
        expect(attachSpy).toHaveBeenCalledWith("live123");
        expect(dockerRunnerStartSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(0);
      } finally {
        findSpy.mockRestore();
        attachSpy.mockRestore();
      }
    });

    it("leaves a running session alone with --detach", async () => {
      const findSpy = liveSession();
      const attachSpy = spyOn(containerReuse, "attachToContainer").mockResolvedValue(undefined);

      try {
        await runAgent("test-profile", { detach: true });

        expect(attachSpy).not.toHaveBeenCalled();
        expect(dockerRunnerStartSpy).not.toHaveBeenCalled();
        expect(stopContainerSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(0);
      } finally {
        findSpy.mockRestore();
        attachSpy.mockRestore();
      }
    });

    it("refuses a custom command for a running session", async () => {
      const findSpy = liveSession();

      try {
        await runAgent("test-profile", { command: ["npm", "test"] });

        expect(dockerRunnerStartSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      } finally {
        findSpy.mockRestore();
      }
    });

    it("replaces the running session with --recreate", async () => {
      const findSpy = liveSession();

      try {
        await runAgent("test-profile", { recreate: true });

        expect(stopContainerSpy).toHaveBeenCalled();
        expect(removeContainerSpy).toHaveBeenCalledWith("live123", { force: true });
        expect(dockerRunnerStartSpy).toHaveBeenCalledWith(
          expect.objectContaining({ recreate: true })
        );
      } finally {
        findSpy.mockRestore();
      }
    });

    it("refuses when a running container with that name isn't this session's", async () => {
      const findSpy = liveSession({ ...ownLabels, "heretic.project": "/other/project" });
      const attachSpy = spyOn(containerReuse, "attachToContainer").mockResolvedValue(undefined);

      try {
        await runAgent("test-profile", {});

        expect(attachSpy).not.toHaveBeenCalled();
        expect(dockerRunnerStartSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      } finally {
        findSpy.mockRestore();
        attachSpy.mockRestore();
      }
    });

    it("hands a stopped session to the runner, which reuses or recreates it", async () => {
      const findSpy = spyOn(dockerUtils, "findContainerByName").mockResolvedValue({
        Id: "old123",
        Names: [`/${sessionName}`],
        State: "exited",
        Labels: ownLabels,
      } as any);

      try {
        await runAgent("test-profile", { detach: true });
        expect(removeContainerSpy).not.toHaveBeenCalled();
        expect(dockerRunnerStartSpy).toHaveBeenCalledWith(
          expect.objectContaining({ detach: true, recreate: false })
        );
      } finally {
        findSpy.mockRestore();
      }
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
