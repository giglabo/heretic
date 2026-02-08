import { describe, it, expect } from "bun:test";
import { createProgram } from "../src/cli";

describe("createProgram", () => {
  it("should create a Commander program", () => {
    const program = createProgram();
    expect(program).toBeDefined();
    expect(program.name()).toBe("heretic-cli");
  });

  it("should have expected commands registered", () => {
    const program = createProgram();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toContain("init");
    expect(commandNames).toContain("local-init");
    expect(commandNames).toContain("local-validate");
    expect(commandNames).toContain("doctor");
    expect(commandNames).toContain("update");
    expect(commandNames).toContain("ps");
    expect(commandNames).toContain("stop");
    expect(commandNames).toContain("attach");
    expect(commandNames).toContain("agents");
    expect(commandNames).toContain("run");
  });

  it("should have global options", () => {
    const program = createProgram();
    const options = program.options.map((opt) => opt.long);

    expect(options).toContain("--verbose");
    expect(options).toContain("--log-file");
    expect(options).toContain("--version");
  });

  it("run command should have session and detach options", () => {
    const program = createProgram();
    const runCmd = program.commands.find((cmd) => cmd.name() === "run");
    expect(runCmd).toBeDefined();

    const optionNames = runCmd!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--detach");
    expect(optionNames).toContain("--session");
    expect(optionNames).toContain("--mcp");
  });

  it("ps command should have json and session options", () => {
    const program = createProgram();
    const psCmd = program.commands.find((cmd) => cmd.name() === "ps");
    expect(psCmd).toBeDefined();

    const optionNames = psCmd!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--session");
  });

  it("stop command should have all, force, keep, session options", () => {
    const program = createProgram();
    const stopCmd = program.commands.find((cmd) => cmd.name() === "stop");
    expect(stopCmd).toBeDefined();

    const optionNames = stopCmd!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--all");
    expect(optionNames).toContain("--force");
    expect(optionNames).toContain("--keep");
    expect(optionNames).toContain("--session");
  });

  it("attach command should have session option", () => {
    const program = createProgram();
    const attachCmd = program.commands.find((cmd) => cmd.name() === "attach");
    expect(attachCmd).toBeDefined();

    const optionNames = attachCmd!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--session");
  });
});
