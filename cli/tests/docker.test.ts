import { describe, it, expect, beforeAll } from "bun:test";
import {
  createDockerClient,
  getDockerClient,
  getDockerSocketPath,
  isDockerAvailable,
  getDockerVersion,
  getDockerInfo,
  listImages,
  listContainers,
} from "../src/utils/docker";

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
