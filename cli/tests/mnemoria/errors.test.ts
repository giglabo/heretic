import { describe, test, expect } from "bun:test";
import {
  EXIT_AUTH,
  EXIT_CONNECTION,
  EXIT_GENERAL,
  MnemoniaAmbiguousError,
  MnemoniaAuthError,
  MnemoniaConflictError,
  MnemoniaConnectionError,
  MnemoniaError,
  MnemoniaForbiddenError,
  MnemoniaNotFoundError,
  MnemoniaPalaceRequiredError,
  MnemoniaRateLimitError,
  MnemoniaServerError,
  MnemoniaTimeoutError,
  MnemoniaValidationError,
} from "../../src/commands/mnemoria/errors";
import { HereticError } from "../../src/utils/errors";

describe("MnemoniaError hierarchy", () => {
  test("MnemoniaError is a HereticError", () => {
    const err = new MnemoniaError("oops");
    expect(err).toBeInstanceOf(HereticError);
    expect(err).toBeInstanceOf(Error);
  });

  test("MnemoniaAuthError has exitCode 2", () => {
    expect(new MnemoniaAuthError("token expired").exitCode).toBe(EXIT_AUTH);
  });

  test("MnemoniaConnectionError has exitCode 3", () => {
    expect(new MnemoniaConnectionError("http://localhost").exitCode).toBe(EXIT_CONNECTION);
  });

  test("MnemoniaTimeoutError has exitCode 3", () => {
    expect(new MnemoniaTimeoutError("http://localhost", 1000).exitCode).toBe(EXIT_CONNECTION);
  });

  test("MnemoniaForbiddenError has exitCode 1 and status 403", () => {
    const err = new MnemoniaForbiddenError("denied");
    expect(err.exitCode).toBe(EXIT_GENERAL);
    expect(err.statusCode).toBe(403);
  });

  test("MnemoniaNotFoundError includes resource name", () => {
    const err = new MnemoniaNotFoundError("Palace", "acme");
    expect(err.message).toContain("Palace");
    expect(err.message).toContain("acme");
    expect(err.statusCode).toBe(404);
  });

  test("MnemoniaValidationError supports fieldErrors", () => {
    const err = new MnemoniaValidationError("bad input", ["name required", "id invalid"]);
    expect(err.message).toContain("name required");
    expect(err.message).toContain("id invalid");
  });

  test("MnemoniaConflictError has status 409", () => {
    expect(new MnemoniaConflictError("dup").statusCode).toBe(409);
  });

  test("MnemoniaRateLimitError records retry-after", () => {
    const err = new MnemoniaRateLimitError(30);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
  });

  test("MnemoniaServerError carries the server status code", () => {
    expect(new MnemoniaServerError(502, "bad gateway").statusCode).toBe(502);
  });

  test("MnemoniaPalaceRequiredError has helpful suggestion", () => {
    const err = new MnemoniaPalaceRequiredError();
    expect(err.suggestion).toContain("use-palace");
  });

  test("MnemoniaAmbiguousError lists candidates", () => {
    const err = new MnemoniaAmbiguousError("palace", "acme", ["acme-dev", "acme-prod"]);
    expect(err.message).toContain("acme-dev");
    expect(err.message).toContain("acme-prod");
  });
});
