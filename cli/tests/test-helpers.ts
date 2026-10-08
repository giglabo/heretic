import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  setPathProvider,
  resetPathProvider,
  TestProfilePathProvider,
} from "../src/utils/profile-paths";

export function createTestContext(prefix: string) {
  const testDir = join(
    tmpdir(),
    `heretic-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  return {
    testDir,
    setup() {
      setPathProvider(new TestProfilePathProvider(testDir));
      const agentsDir = join(testDir, "agents");
      if (!existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
      }
    },
    teardown() {
      resetPathProvider();
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    },
  };
}
