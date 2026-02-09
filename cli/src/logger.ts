import pino from "pino";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LoggerOptions {
  verbose?: boolean;
  logFile?: string;
}

let logger: pino.Logger;

/**
 * Check if running from a compiled Bun binary
 */
function isCompiledBinary(): boolean {
  // Bun compiled binaries run from /$bunfs/ virtual filesystem
  return process.argv[0]?.includes("$bunfs") || process.argv[1]?.includes("$bunfs");
}

/**
 * Initialize the logger with options
 */
export function initLogger(options: LoggerOptions = {}): pino.Logger {
  const { verbose = false, logFile } = options;

  // In compiled binary, pino-pretty transport doesn't work
  // Use simple formatted logging instead
  if (isCompiledBinary()) {
    const streams: pino.StreamEntry[] = [
      {
        level: verbose ? "debug" : "info",
        stream: {
          write(msg: string): void {
            try {
              const obj = JSON.parse(msg);
              const level = obj.level;
              const message = obj.msg || "";
              const levelName =
                level === 10
                  ? "TRACE"
                  : level === 20
                    ? "DEBUG"
                    : level === 30
                      ? "INFO"
                      : level === 40
                        ? "WARN"
                        : level === 50
                          ? "ERROR"
                          : "LOG";

              // Simple colored output
              const colors: Record<string, string> = {
                TRACE: "\x1b[90m",
                DEBUG: "\x1b[36m",
                INFO: "\x1b[34m",
                WARN: "\x1b[33m",
                ERROR: "\x1b[31m",
                LOG: "\x1b[0m",
              };
              const reset = "\x1b[0m";
              const color = colors[levelName] || reset;

              process.stdout.write(`${color}${levelName}${reset} ${message}\n`);
            } catch {
              process.stdout.write(msg);
            }
          },
        },
      },
    ];

    // Add file stream if specified
    if (logFile) {
      const logDir = dirname(logFile);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const fileStream = pino.destination(logFile);
      streams.push({ level: "trace", stream: fileStream });
    }

    logger = pino(
      {
        level: verbose ? "debug" : "info",
      },
      pino.multistream(streams)
    );
    return logger;
  }

  // Dev mode: use pino-pretty for nice formatting
  const targets: pino.TransportTargetOptions[] = [];

  // Console transport with pretty printing
  targets.push({
    target: "pino-pretty",
    level: verbose ? "debug" : "info",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
      singleLine: false,
      hideObject: !verbose,
      customColors: "info:blue,warn:yellow,error:red",
    },
  });

  // File transport if specified
  if (logFile) {
    // Ensure directory exists
    const logDir = dirname(logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    targets.push({
      target: "pino/file",
      level: "trace",
      options: {
        destination: logFile,
        mkdir: true,
      },
    });
  }

  logger = pino({
    level: verbose ? "debug" : "info",
    transport:
      targets.length === 1
        ? targets[0]
        : {
            targets,
          },
  });

  return logger;
}

/**
 * Get the current logger instance
 */
export function getLogger(): pino.Logger {
  if (!logger) {
    // Initialize with defaults if not already initialized
    logger = initLogger();
  }
  return logger;
}

/**
 * Helper function to log without timestamp/level (for CLI output like help text)
 */
export function logRaw(message: string): void {
  console.log(message);
}
