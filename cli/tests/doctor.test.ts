import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { runDoctor } from "../src/commands/doctor";
import * as dockerUtils from "../src/utils/docker";
import * as profileLoader from "../src/utils/profile-loader";
import * as localConfig from "../src/utils/local-config";
import * as configResolver from "../src/utils/config-resolver";
import * as settings from "../src/utils/settings";
import * as fs from "fs";
import {
  setPathProvider,
  resetPathProvider,
  TestProfilePathProvider,
} from "../src/utils/profile-paths";

describe("Doctor Command", () => {
  let isDockerAvailableSpy: ReturnType<typeof spyOn>;
  let getDockerVersionSpy: ReturnType<typeof spyOn>;
  let listImagesSpy: ReturnType<typeof spyOn>;
  let pullImageSpy: ReturnType<typeof spyOn>;
  let loadAllProfilesSpy: ReturnType<typeof spyOn>;
  let validateProfileSpy: ReturnType<typeof spyOn>;
  let listLocalConfigsSpy: ReturnType<typeof spyOn>;
  let resolveConfigSpy: ReturnType<typeof spyOn>;
  let validateResolvedConfigSpy: ReturnType<typeof spyOn>;
  let loadSettingsSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let mkdirSyncSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Use test path provider so doctor.ts resolves paths via the provider
    setPathProvider(new TestProfilePathProvider("/home/testuser/.heretic"));

    // Mock Docker utilities
    isDockerAvailableSpy = spyOn(dockerUtils, "isDockerAvailable").mockResolvedValue(true);
    getDockerVersionSpy = spyOn(dockerUtils, "getDockerVersion").mockResolvedValue({
      Version: "24.0.0",
      ApiVersion: "1.43",
      Platform: { Name: "" },
    });
    listImagesSpy = spyOn(dockerUtils, "listImages").mockResolvedValue([
      { RepoTags: ["test/image:latest"] },
    ]);
    pullImageSpy = spyOn(dockerUtils, "pullImage").mockResolvedValue(undefined);

    // Mock profile loader
    loadAllProfilesSpy = spyOn(profileLoader, "loadAllProfiles").mockReturnValue({
      "test-profile": {
        image: "test/image:latest",
        runner: "docker",
      },
    });
    validateProfileSpy = spyOn(profileLoader, "validateProfile").mockReturnValue([]);

    // Mock local config
    listLocalConfigsSpy = spyOn(localConfig, "listLocalConfigs").mockReturnValue([]);
    resolveConfigSpy = spyOn(configResolver, "resolveConfig").mockReturnValue({
      image: "test/image:latest",
      runner: "docker",
      command: ["/bin/bash"],
      workdir: "/app",
      volumes: [],
    });
    validateResolvedConfigSpy = spyOn(configResolver, "validateResolvedConfig").mockReturnValue([]);

    // Mock settings
    loadSettingsSpy = spyOn(settings, "loadSettings").mockReturnValue({});

    // Mock fs
    existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    mkdirSyncSpy = spyOn(fs, "mkdirSync").mockImplementation(() => "");

    // Mock process.exit
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    // Mock fetch for network check
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
      } as Response)
    ) as typeof global.fetch;
  });

  afterEach(() => {
    isDockerAvailableSpy.mockRestore();
    getDockerVersionSpy.mockRestore();
    listImagesSpy.mockRestore();
    pullImageSpy.mockRestore();
    loadAllProfilesSpy.mockRestore();
    validateProfileSpy.mockRestore();
    listLocalConfigsSpy.mockRestore();
    resolveConfigSpy.mockRestore();
    validateResolvedConfigSpy.mockRestore();
    loadSettingsSpy.mockRestore();
    existsSyncSpy.mockRestore();
    mkdirSyncSpy.mockRestore();
    exitSpy.mockRestore();
    resetPathProvider();
  });

  it("exits with 0 when all checks pass", async () => {
    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with 1 when Docker is unavailable", async () => {
    isDockerAvailableSpy.mockResolvedValue(false);

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when Docker version is too old", async () => {
    getDockerVersionSpy.mockResolvedValue({
      Version: "20.0.0",
      ApiVersion: "1.40",
      Platform: { Name: "" },
    });

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Note: Docker Compose check is tested in manual testing as Bun.spawn cannot be easily mocked

  it("creates config directory when --fix is provided", async () => {
    existsSyncSpy.mockReturnValue(false);

    try {
      await runDoctor({ fix: true });
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(mkdirSyncSpy).toHaveBeenCalledWith("/home/testuser/.heretic", {
      recursive: true,
    });
  });

  it("warns when settings file is missing", async () => {
    loadSettingsSpy.mockImplementation(() => {
      throw new Error("Settings file not found");
    });

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    // Should still exit 0 (warnings don't cause failure)
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with 1 when profile validation fails", async () => {
    validateProfileSpy.mockReturnValue(["Missing image field"]);

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("validates local config when present", async () => {
    listLocalConfigsSpy.mockReturnValue(["test-profile"]);

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(resolveConfigSpy).toHaveBeenCalled();
    expect(validateResolvedConfigSpy).toHaveBeenCalled();
  });

  it("exits with 1 when local config validation fails", async () => {
    listLocalConfigsSpy.mockReturnValue(["test-profile"]);
    validateResolvedConfigSpy.mockReturnValue(["Invalid volume path"]);

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("pulls missing images when --fix is provided", async () => {
    listImagesSpy.mockResolvedValue([]);
    loadAllProfilesSpy.mockReturnValue({
      "test-profile": {
        image: "missing/image:latest",
        runner: "docker",
      },
    });

    try {
      await runDoctor({ fix: true });
    } catch {
      // Expected to throw due to process.exit mock
    }

    expect(pullImageSpy).toHaveBeenCalledWith("missing/image:latest");
  });

  it("warns when network connectivity fails", async () => {
    global.fetch = mock(() => Promise.reject(new Error("Network error"))) as typeof global.fetch;

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    // Should still exit 0 (warnings don't cause failure)
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("runs all checks without short-circuiting", async () => {
    // Set first check to fail
    isDockerAvailableSpy.mockResolvedValue(false);

    try {
      await runDoctor({});
    } catch {
      // Expected to throw due to process.exit mock
    }

    // All other checks should still have been called
    expect(getDockerVersionSpy).toHaveBeenCalled();
    expect(loadAllProfilesSpy).toHaveBeenCalled();
    expect(loadSettingsSpy).toHaveBeenCalled();
  });
});
