import { HereticError } from "../../utils/errors";

/**
 * Exit code conventions for the Mnemoria CLI.
 * Success = 0, general error = 1, auth failure = 2, connection failure = 3,
 * user cancellation = 130.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL = 1;
export const EXIT_AUTH = 2;
export const EXIT_CONNECTION = 3;
export const EXIT_CANCELLED = 130;

/**
 * Base class for every Mnemoria CLI error. Carries an optional HTTP status
 * code so the top-level error handler can decide on the exit code without
 * a secondary lookup.
 */
export class MnemoniaError extends HereticError {
  statusCode?: number;
  code?: string;
  exitCode: number;

  constructor(
    message: string,
    suggestion?: string,
    statusCode?: number,
    exitCode: number = EXIT_GENERAL
  ) {
    super(message, suggestion);
    this.statusCode = statusCode;
    this.exitCode = exitCode;
  }
}

export class MnemoniaConnectionError extends MnemoniaError {
  constructor(url: string, cause?: Error) {
    super(
      `Cannot connect to Mnemoria server at ${url}`,
      "Check that the server is running and the URL is correct.\n" +
        "Run 'heretic-cli mnemoria config show' to see current settings.",
      undefined,
      EXIT_CONNECTION
    );
    if (cause) this.cause = cause;
  }
}

export class MnemoniaTimeoutError extends MnemoniaError {
  constructor(url: string, timeoutMs: number) {
    super(
      `Request to ${url} timed out after ${timeoutMs}ms`,
      "Increase 'server.timeout' in ~/.heretic/mnemoria/config.yaml, or set MN_SERVER_TIMEOUT.",
      undefined,
      EXIT_CONNECTION
    );
  }
}

export class MnemoniaAuthError extends MnemoniaError {
  constructor(detail: string) {
    super(
      `Authentication failed: ${detail}`,
      "Run 'heretic-cli mnemoria config login' to re-authenticate.",
      401,
      EXIT_AUTH
    );
  }
}

export class MnemoniaForbiddenError extends MnemoniaError {
  constructor(action: string) {
    super(
      `Permission denied: ${action}`,
      "Your role does not have permission for this action.\n" +
        "Contact your administrator to request the required role.",
      403,
      EXIT_GENERAL
    );
  }
}

export class MnemoniaNotFoundError extends MnemoniaError {
  constructor(resource: string, identifier: string) {
    const kind = resource.toLowerCase();
    super(
      `${resource} "${identifier}" not found`,
      `Run 'heretic-cli mnemoria ${kind} list' to see available ${kind}s.`,
      404,
      EXIT_GENERAL
    );
  }
}

export class MnemoniaValidationError extends MnemoniaError {
  constructor(detail: string, fieldErrors?: string[]) {
    const msg = fieldErrors?.length
      ? `${detail}\n${fieldErrors.map((e) => `  - ${e}`).join("\n")}`
      : detail;
    super(msg, undefined, 400, EXIT_GENERAL);
  }
}

export class MnemoniaConflictError extends MnemoniaError {
  constructor(detail: string) {
    super(detail, undefined, 409, EXIT_GENERAL);
  }
}

export class MnemoniaRateLimitError extends MnemoniaError {
  retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number) {
    super(
      `Rate limited by the Mnemoria server${
        retryAfterSeconds ? ` (retry after ${retryAfterSeconds}s)` : ""
      }`,
      "Wait before retrying, or reduce concurrency.",
      429,
      EXIT_GENERAL
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class MnemoniaServerError extends MnemoniaError {
  constructor(status: number, detail: string) {
    super(
      `Mnemoria server error ${status}: ${detail}`,
      "This is a server-side issue. Check the server logs.",
      status,
      EXIT_GENERAL
    );
  }
}

export class MnemoniaPalaceRequiredError extends MnemoniaError {
  constructor() {
    super(
      "No palace specified and no default palace configured",
      "Use -P <palace> flag or set a default:\n" +
        "  heretic-cli mnemoria config use-palace <name>",
      undefined,
      EXIT_GENERAL
    );
  }
}

export class MnemoniaAmbiguousError extends MnemoniaError {
  constructor(resource: string, name: string, candidates: string[]) {
    super(
      `Ambiguous ${resource} name "${name}". Matches: ${candidates.join(", ")}`,
      "Use the full name or ID to disambiguate.",
      undefined,
      EXIT_GENERAL
    );
  }
}

export class MnemoniaConfigError extends MnemoniaError {
  constructor(message: string, suggestion?: string) {
    super(message, suggestion, undefined, EXIT_GENERAL);
  }
}
