import { describe, it, expect } from "bun:test";
import { createProgram } from "../src/cli";

describe("image command registration", () => {
  it("registers image command on the program", () => {
    const program = createProgram();
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain("image");
  });

  it("has build and generate subcommands", () => {
    const program = createProgram();
    const imageCmd = program.commands.find((cmd) => cmd.name() === "image");
    expect(imageCmd).toBeDefined();

    const subcommands = imageCmd!.commands.map((cmd) => cmd.name());
    expect(subcommands).toContain("build");
    expect(subcommands).toContain("generate");
  });

  it("build subcommand has expected options", () => {
    const program = createProgram();
    const imageCmd = program.commands.find((cmd) => cmd.name() === "image");
    const buildCmd = imageCmd!.commands.find((cmd) => cmd.name() === "build");
    expect(buildCmd).toBeDefined();

    const optionNames = buildCmd!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--agent");
    expect(optionNames).toContain("--combined");
    expect(optionNames).toContain("--name");
    expect(optionNames).toContain("--tag");
    expect(optionNames).toContain("--registry");
    expect(optionNames).toContain("--push");
    expect(optionNames).toContain("--no-cache");
    expect(optionNames).toContain("--dry-run");
    expect(optionNames).toContain("--arch");
    expect(optionNames).toContain("--base");
    expect(optionNames).toContain("--with-python");
    expect(optionNames).toContain("--with-go");
    expect(optionNames).toContain("--with-java");
    expect(optionNames).toContain("--with-rust");
    expect(optionNames).toContain("--with-docker");
    expect(optionNames).toContain("--with-all");
  });

  it("generate subcommand has format option", () => {
    const program = createProgram();
    const imageCmd = program.commands.find((cmd) => cmd.name() === "image");
    const generateCmd = imageCmd!.commands.find((cmd) => cmd.name() === "generate");
    expect(generateCmd).toBeDefined();

    const optionNames = generateCmd!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--format");
    // Should also have shared template options
    expect(optionNames).toContain("--agent");
    expect(optionNames).toContain("--with-python");
  });
});
