/**
 * Tests for `run` argv normalization (options after the agent name).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createProgram } from "../src/cli";
import { normalizeRunArgv } from "../src/utils/run-argv";
import * as runAgentModule from "../src/commands/run-agent";

const BASE = ["bun", "heretic-cli"];
const normalize = (...args: string[]): string[] =>
  normalizeRunArgv([...BASE, ...args], createProgram()).slice(2);

describe("normalizeRunArgv", () => {
  test("moves options after the agent name in front of it, in any order", () => {
    expect(normalize("run", "cs", "--root", "-s", "second-2")).toEqual([
      "run",
      "--root",
      "-s",
      "second-2",
      "cs",
    ]);
    expect(normalize("run", "cs", "-s", "second-2", "--root")).toEqual([
      "run",
      "-s",
      "second-2",
      "--root",
      "cs",
    ]);
  });

  test("handles value options, --long=value, -sVALUE and negated flags", () => {
    expect(
      normalize(
        "run",
        "cs",
        "-d",
        "--session=b",
        "-p",
        "3000",
        "-sx",
        "--no-ports",
        "--sidecar",
        "node"
      )
    ).toEqual([
      "run",
      "-d",
      "--session=b",
      "-p",
      "3000",
      "-sx",
      "--no-ports",
      "--sidecar",
      "node",
      "cs",
    ]);
  });

  test("leaves options already before the agent name alone", () => {
    expect(normalize("run", "-s", "a", "--root", "cs")).toEqual(["run", "-s", "a", "--root", "cs"]);
  });

  test("keeps a custom command's own flags (the command starts at the first non-option)", () => {
    expect(normalize("run", "cs", "npm", "test", "-s", "x")).toEqual([
      "run",
      "cs",
      "npm",
      "test",
      "-s",
      "x",
    ]);
    expect(normalize("run", "cs", "-s", "a", "npm", "test", "-p", "1")).toEqual([
      "run",
      "-s",
      "a",
      "cs",
      "npm",
      "test",
      "-p",
      "1",
    ]);
  });

  test("still hoists a bare --root from inside the command, but not after --", () => {
    expect(normalize("run", "cs", "npm", "test", "--root")).toEqual([
      "run",
      "--root",
      "cs",
      "npm",
      "test",
    ]);
    expect(normalize("run", "cs", "--", "npm", "--root", "-s", "x")).toEqual([
      "run",
      "cs",
      "--",
      "npm",
      "--root",
      "-s",
      "x",
    ]);
    expect(normalize("run", "cs", "-s", "a", "--", "npm", "--root")).toEqual([
      "run",
      "-s",
      "a",
      "cs",
      "--",
      "npm",
      "--root",
    ]);
  });

  test("stops at an unknown option (it starts the custom command)", () => {
    expect(normalize("run", "cs", "--foo", "-s", "x")).toEqual(["run", "cs", "--foo", "-s", "x"]);
  });

  test("skips global options before the run keyword", () => {
    expect(normalize("-V", "--log-file", "/tmp/h.log", "run", "cs", "-s", "x")).toEqual([
      "-V",
      "--log-file",
      "/tmp/h.log",
      "run",
      "-s",
      "x",
      "cs",
    ]);
  });

  test("does not touch other commands or the bare-agent shortcut", () => {
    expect(normalize("cs", "-s", "x", "--root")).toEqual(["cs", "-s", "x", "--root"]);
    expect(normalize("ps", "-s", "x")).toEqual(["ps", "-s", "x"]);
    expect(normalize("run")).toEqual(["run"]);
  });
});

describe("run option parsing after the agent name", () => {
  let runAgentSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    runAgentSpy = spyOn(runAgentModule, "runAgent").mockResolvedValue(undefined);
  });

  afterEach(() => {
    runAgentSpy.mockRestore();
  });

  const parse = async (...args: string[]): Promise<[string, Record<string, unknown>]> => {
    const program = createProgram();
    await program.parseAsync(normalizeRunArgv([...BASE, ...args], program));
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    return runAgentSpy.mock.calls[0] as [string, Record<string, unknown>];
  };

  test("run cs --root -s second-2 → session second-2 as root, no custom command", async () => {
    const [agent, opts] = await parse("run", "cs", "--root", "-s", "second-2");
    expect(agent).toBe("cs");
    expect(opts.session).toBe("second-2");
    expect(opts.asRoot).toBe(true);
    expect(opts.command).toBeUndefined();
  });

  test("run cs -s second-2 -d -p 3000 npm test --watch", async () => {
    const [agent, opts] = await parse(
      "run",
      "cs",
      "-s",
      "second-2",
      "-d",
      "-p",
      "3000",
      "npm",
      "test",
      "--watch"
    );
    expect(agent).toBe("cs");
    expect(opts.session).toBe("second-2");
    expect(opts.detach).toBe(true);
    expect(opts.port).toEqual(["3000"]);
    expect(opts.command).toEqual(["npm", "test", "--watch"]);
  });
});
