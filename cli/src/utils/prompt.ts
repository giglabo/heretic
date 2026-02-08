import inquirer from "inquirer";
import { getLogger } from "../logger";

/**
 * Check if running from a compiled Bun binary.
 * Compiled binaries have issues with inquirer's list/checkbox types,
 * so we fall back to numbered text input.
 */
export function isCompiledBinary(): boolean {
  return process.argv[0]?.includes("$bunfs") || process.argv[1]?.includes("$bunfs");
}

/**
 * Prompt for a list selection with fallback for compiled binary.
 * In compiled binary, shows numbered options and accepts number input
 * instead of using inquirer's arrow-key list which can malfunction.
 */
export async function promptList<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T }>
): Promise<T> {
  const logger = getLogger();

  if (isCompiledBinary()) {
    // Fallback: show numbered options
    logger.info(`\n${message}`);
    choices.forEach((choice, index) => {
      logger.info(`  ${index + 1}. ${choice.name}`);
    });

    const answer = await inquirer.prompt([
      {
        type: "input",
        name: "selection",
        message: "Enter number:",
        validate: (input: string): string | boolean => {
          const num = parseInt(input, 10);
          if (isNaN(num) || num < 1 || num > choices.length) {
            return `Please enter a number between 1 and ${choices.length}`;
          }
          return true;
        },
      },
    ]);

    const index = parseInt(answer.selection, 10) - 1;
    return choices[index].value;
  }

  // Normal mode: use inquirer list
  const answer = await inquirer.prompt([
    {
      type: "list",
      name: "selection",
      message,
      choices,
    },
  ]);

  return answer.selection;
}
