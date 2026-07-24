import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  computeCodeChallenge,
  createTokenProvider,
  generateCodeVerifier,
  isExpired,
  selectAuthMethod,
} from "../../src/commands/mnemoria/auth";
import type { EffectiveMnemoniaConfig } from "../../src/commands/mnemoria/config-loader";
import * as configLoader from "../../src/commands/mnemoria/config-loader";
import { MnemoniaAuthError } from "../../src/commands/mnemoria/errors";

const baseConfig = (
  overrides: Partial<EffectiveMnemoniaConfig["auth"]> = {}
): EffectiveMnemoniaConfig => ({
  profile: "default",
  server: { url: "http://localhost:3000", timeout: 1000, retry: { attempts: 0, delay: 10 } },
  auth: {
    mode: "oidc",
    provider: "keycloak",
    issuer: "https://auth.example/realms/test",
    client_id: "test",
    token_script: "",
    ...overrides,
  },
  defaults: {
    palace: "",
    language: "en",
    output: "table",
    page_size: 20,
    wing: "",
    room: "",
  },
  output: { color: "auto", timestamps: "relative", ids: "short" },
});

describe("auth: isExpired", () => {
  test("undefined → expired", () => {
    expect(isExpired(undefined)).toBe(true);
  });
  test("past date → expired", () => {
    expect(isExpired("2020-01-01T00:00:00Z")).toBe(true);
  });
  test("far-future date → not expired", () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    expect(isExpired(future)).toBe(false);
  });
  test("within 30s skew → expired", () => {
    const near = new Date(Date.now() + 10_000).toISOString();
    expect(isExpired(near)).toBe(true);
  });
});

describe("auth: PKCE helpers", () => {
  test("code verifier is url-safe base64", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThan(40);
  });
  test("code challenge is deterministic from verifier", () => {
    const v = "test-verifier-123";
    const c1 = computeCodeChallenge(v);
    const c2 = computeCodeChallenge(v);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("auth: createTokenProvider", () => {
  let loadSpy: ReturnType<typeof spyOn>;
  let saveSpy: ReturnType<typeof spyOn>;
  const originalAccessToken = process.env.MN_ACCESS_TOKEN;

  beforeEach(() => {
    loadSpy = spyOn(configLoader, "loadAuthFile");
    saveSpy = spyOn(configLoader, "saveAuthFile").mockImplementation(() => {});
    delete process.env.MN_ACCESS_TOKEN;
  });

  afterEach(() => {
    loadSpy.mockRestore();
    saveSpy.mockRestore();
    if (originalAccessToken !== undefined) process.env.MN_ACCESS_TOKEN = originalAccessToken;
  });

  test("returns env var token first", async () => {
    process.env.MN_ACCESS_TOKEN = "env-token";
    loadSpy.mockReturnValue(null);
    const provider = createTokenProvider(baseConfig());
    expect(await provider()).toBe("env-token");
  });

  test("returns null when auth mode is disabled", async () => {
    loadSpy.mockReturnValue(null);
    const provider = createTokenProvider(baseConfig({ mode: "disabled" }));
    expect(await provider()).toBeNull();
  });

  test("returns null when no stored token and no env", async () => {
    loadSpy.mockReturnValue(null);
    const provider = createTokenProvider(baseConfig());
    expect(await provider()).toBeNull();
  });

  test("returns stored access token when not expired", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    loadSpy.mockReturnValue({ access_token: "stored", token_expiry: future });
    const provider = createTokenProvider(baseConfig());
    expect(await provider()).toBe("stored");
  });

  test("throws MnemoniaAuthError when token expired and no refresh", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    loadSpy.mockReturnValue({ access_token: "stale", token_expiry: past });
    const provider = createTokenProvider(baseConfig());
    await expect(provider()).rejects.toBeInstanceOf(MnemoniaAuthError);
  });

  test("refreshes expired access token using refresh_token", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 86400_000).toISOString();
    loadSpy.mockReturnValue({
      access_token: "old",
      token_expiry: past,
      refresh_token: "refresh-1",
      refresh_expiry: future,
      issuer: "https://auth.example/realms/test",
      client_id: "test",
      provider: "keycloak",
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new",
          refresh_token: "refresh-2",
          expires_in: 3600,
        })
      )
    );
    const provider = createTokenProvider(baseConfig());
    const token = await provider();
    expect(token).toBe("new");
    expect(fetchSpy).toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("auth: selectAuthMethod", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("outside container, macOS → pkce", () => {
    delete process.env.MN_CONTAINER;
    delete process.env.MN_AUTH_CALLBACK_PORT;
    const existsSpy = spyOn(fs, "existsSync").mockImplementation(
      ((p: string) => p !== "/.dockerenv") as never
    );
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(selectAuthMethod()).toBe("pkce");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      existsSpy.mockRestore();
    }
  });

  test("inside container, no port → device_flow", () => {
    process.env.MN_CONTAINER = "1";
    delete process.env.MN_AUTH_CALLBACK_PORT;
    expect(selectAuthMethod()).toBe("device_flow");
  });

  test("inside container, port set → pkce_forwarded", () => {
    process.env.MN_CONTAINER = "1";
    process.env.MN_AUTH_CALLBACK_PORT = "19876";
    expect(selectAuthMethod()).toBe("pkce_forwarded");
  });
});
