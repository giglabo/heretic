import { describe, it, expect, beforeAll } from "bun:test";
import {
  createDockerClient,
  getDockerClient,
  getDockerSocketPath,
  getDockerSocketMountSource,
  isDockerAvailable,
  getDockerVersion,
  getDockerInfo,
  listImages,
  listContainers,
  findContainerByName,
  isContainerActive,
} from "../src/utils/docker";
import type Docker from "dockerode";
import type { ContainerInfo } from "dockerode";

describe("Docker Utils", () => {
  let dockerAvailable: boolean;

  beforeAll(async () => {
    dockerAvailable = await isDockerAvailable();
  });

  describe("createDockerClient", () => {
    it("should create a Docker client instance", () => {
      const client = createDockerClient();
      expect(client).toBeDefined();
      expect(client.modem).toBeDefined();
    });

    it("should create client with custom options", () => {
      const client = createDockerClient({
        socketPath: "/var/run/docker.sock",
      });
      expect(client).toBeDefined();
    });
  });

  describe("getDockerClient", () => {
    it("should return default Docker client", () => {
      const client = getDockerClient();
      expect(client).toBeDefined();
      expect(client.modem).toBeDefined();
    });
  });

  describe("getDockerSocketMountSource", () => {
    it("uses the VM daemon's socket on macOS and Windows, not the client's", () => {
      expect(getDockerSocketMountSource("darwin", undefined)).toBe("/var/run/docker.sock");
      expect(getDockerSocketMountSource("darwin", "unix:///Users/me/.docker/run/docker.sock")).toBe(
        "/var/run/docker.sock"
      );
      expect(getDockerSocketMountSource("win32", undefined)).toBe("/var/run/docker.sock");
    });

    it("honours a unix DOCKER_HOST on Linux (rootless)", () => {
      expect(getDockerSocketMountSource("linux", "unix:///run/user/1000/docker.sock")).toBe(
        "/run/user/1000/docker.sock"
      );
      expect(getDockerSocketMountSource("linux", "tcp://10.0.0.1:2375")).toBe(
        "/var/run/docker.sock"
      );
      expect(getDockerSocketMountSource("linux", undefined)).toBe("/var/run/docker.sock");
    });
  });

  describe("getDockerSocketPath", () => {
    it("should return a string path", () => {
      const path = getDockerSocketPath();
      expect(typeof path).toBe("string");
      expect(path.length).toBeGreaterThan(0);
    });

    it("should return platform-appropriate path", () => {
      const path = getDockerSocketPath();
      if (process.platform === "win32") {
        expect(path).toContain("pipe");
      } else {
        expect(path).toContain("docker.sock");
      }
    });
  });

  describe("findContainerByName", () => {
    const containers = [
      { Id: "aaa", Names: ["/heretic-a-default-12345678"], State: "running" },
      { Id: "bbb", Names: ["/heretic-a-default-12345678-extra"], State: "exited" },
    ] as unknown as ContainerInfo[];
    let listOptions: unknown;
    const docker = {
      listContainers: async (opts: unknown) => {
        listOptions = opts;
        return containers;
      },
    } as unknown as Docker;

    it("should match the exact name, including stopped containers", async () => {
      const found = await findContainerByName("heretic-a-default-12345678", docker);
      expect(found?.Id).toBe("aaa");
      expect(listOptions).toEqual({ all: true });
    });

    it("should return undefined for a prefix-only match", async () => {
      expect(await findContainerByName("heretic-a-default", docker)).toBeUndefined();
    });
  });

  describe("isContainerActive", () => {
    const withState = (State: string): ContainerInfo => ({ State }) as unknown as ContainerInfo;

    it("should treat running, paused and restarting as active", () => {
      for (const state of ["running", "paused", "restarting"]) {
        expect(isContainerActive(withState(state))).toBe(true);
      }
    });

    it("should treat created, exited and dead as inactive", () => {
      for (const state of ["created", "exited", "dead"]) {
        expect(isContainerActive(withState(state))).toBe(false);
      }
    });
  });

  describe("isDockerAvailable", () => {
    it("should check Docker daemon availability", async () => {
      const available = await isDockerAvailable();
      expect(typeof available).toBe("boolean");
    });
  });

  // Only run these tests if Docker is available
  if (process.env.CI !== "true") {
    describe("Docker Operations (requires Docker daemon)", () => {
      it("should get Docker version", async () => {
        if (!dockerAvailable) {
          console.log("Skipping: Docker not available");
          return;
        }

        const version = await getDockerVersion();
        expect(version).toBeDefined();
        expect(version.Version).toBeDefined();
      });

      it("should get Docker info", async () => {
        if (!dockerAvailable) {
          console.log("Skipping: Docker not available");
          return;
        }

        const info = await getDockerInfo();
        expect(info).toBeDefined();
        expect(info.ID).toBeDefined();
      });

      it("should list images", async () => {
        if (!dockerAvailable) {
          console.log("Skipping: Docker not available");
          return;
        }

        const images = await listImages();
        expect(Array.isArray(images)).toBe(true);
      });

      it("should list containers", async () => {
        if (!dockerAvailable) {
          console.log("Skipping: Docker not available");
          return;
        }

        const containers = await listContainers();
        expect(Array.isArray(containers)).toBe(true);
      });

      it("should list all containers including stopped ones", async () => {
        if (!dockerAvailable) {
          console.log("Skipping: Docker not available");
          return;
        }

        const containers = await listContainers(undefined, { all: true });
        expect(Array.isArray(containers)).toBe(true);
      });
    });
  }
});
