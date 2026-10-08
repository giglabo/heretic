import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadEffectiveConfig,
  loadMnemoniaConfigFile,
  saveMnemoniaConfigFile,
  setConfigField,
  ensureMnemoniaDir,
  loadAuthFile,
  saveAuthFile,
  clearAuthFile,
  listMnemoniaProfiles,
  getMnemoniaConfigPath,
  getMnemoniaAuthPath,
} from "../../src/commands/mnemoria/config-loader";
import { MnemoniaConfigError } from "../../src/commands/mnemoria/errors";
import {
  setPathProvider,
  resetPathProvider,
  TestProfilePathProvider,
} from "../../src/utils/profile-paths";

const ENV_KEYS = [
  "MN_SERVER_URL",
  "MN_SERVER_TIMEOUT",
  "MN_AUTH_MODE",
  "MN_AUTH_ISSUER",
  "MN_AUTH_CLIENT_ID",
  "MN_DEFAULT_PALACE",
  "MN_DEFAULT_LANGUAGE",
  "MN_DEFAULT_WING",
  "MN_DEFAULT_ROOM",
  "MN_OUTPUT",
];

describe("mnemoria config-loader", () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mn-config-"));
    setPathProvider(new TestProfilePathProvider(tmp));
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    resetPathProvider();
    rmSync(tmp, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]!;
      else delete process.env[k];
    }
  });

  test("defaults when no config file exists", () => {
    const cfg = loadEffectiveConfig();
    expect(cfg.server.url).toBe("http://localhost:3000");
    expect(cfg.server.timeout).toBe(30000);
    expect(cfg.defaults.output).toBe("table");
    expect(cfg.defaults.language).toBe("en");
    expect(cfg.auth.mode).toBe("oidc");
    expect(cfg.auth.provider).toBe("keycloak");
  });

  test("loads values from config.yaml", () => {
    ensureMnemoniaDir();
    saveMnemoniaConfigFile({
      server: { url: "https://custom.example", timeout: 5000 },
      defaults: { palace: "acme", output: "json" },
    });
    const cfg = loadEffectiveConfig();
    expect(cfg.server.url).toBe("https://custom.example");
    expect(cfg.server.timeout).toBe(5000);
    expect(cfg.defaults.palace).toBe("acme");
    expect(cfg.defaults.output).toBe("json");
  });

  test("env var overrides config.yaml", () => {
    ensureMnemoniaDir();
    saveMnemoniaConfigFile({ server: { url: "https://file.example" } });
    process.env.MN_SERVER_URL = "https://env.example";
    process.env.MN_DEFAULT_PALACE = "palace-from-env";
    const cfg = loadEffectiveConfig();
    expect(cfg.server.url).toBe("https://env.example");
    expect(cfg.defaults.palace).toBe("palace-from-env");
  });

  test("CLI override beats env var", () => {
    process.env.MN_SERVER_URL = "https://env.example";
    const cfg = loadEffectiveConfig({
      cliOverrides: { serverUrl: "https://cli.example" },
    });
    expect(cfg.server.url).toBe("https://cli.example");
  });

  test("profile merges over base config", () => {
    ensureMnemoniaDir();
    saveMnemoniaConfigFile({
      server: { url: "https://base.example" },
      defaults: { language: "en" },
    });
    mkdirSync(join(tmp, "mnemoria", "profiles"), { recursive: true });
    writeFileSync(
      join(tmp, "mnemoria", "profiles", "staging.yaml"),
      "server:\n  url: https://staging.example\ndefaults:\n  palace: stg\n"
    );
    const cfg = loadEffectiveConfig({ profile: "staging" });
    expect(cfg.server.url).toBe("https://staging.example");
    expect(cfg.defaults.palace).toBe("stg");
    expect(cfg.defaults.language).toBe("en");
    expect(cfg.profile).toBe("staging");
  });

  test("missing profile throws MnemoniaConfigError", () => {
    expect(() => loadEffectiveConfig({ profile: "nope" })).toThrow(MnemoniaConfigError);
  });

  test("listMnemoniaProfiles returns sorted profile names", () => {
    mkdirSync(join(tmp, "mnemoria", "profiles"), { recursive: true });
    writeFileSync(join(tmp, "mnemoria", "profiles", "zeta.yaml"), "");
    writeFileSync(join(tmp, "mnemoria", "profiles", "alpha.yml"), "");
    writeFileSync(join(tmp, "mnemoria", "profiles", "notayaml.txt"), "");
    const profiles = listMnemoniaProfiles();
    expect(profiles).toEqual(["alpha", "zeta"]);
  });

  test("getMnemoniaConfigPath / AuthPath honor path provider", () => {
    expect(getMnemoniaConfigPath()).toBe(join(tmp, "mnemoria", "config.yaml"));
    expect(getMnemoniaAuthPath()).toBe(join(tmp, "mnemoria", "auth.yaml"));
  });
});

describe("setConfigField", () => {
  test("sets a nested string field", () => {
    const updated = setConfigField({}, "server.url", "https://x.example");
    expect(updated.server?.url).toBe("https://x.example");
  });

  test("parses numeric fields", () => {
    const updated = setConfigField({}, "server.timeout", "45000");
    expect(updated.server?.timeout).toBe(45000);
  });

  test("rejects unknown keys", () => {
    expect(() => setConfigField({}, "server.nope", "x")).toThrow(MnemoniaConfigError);
  });

  test("rejects invalid enum", () => {
    expect(() => setConfigField({}, "defaults.output", "xml")).toThrow(MnemoniaConfigError);
  });

  test("accepts valid enum", () => {
    const updated = setConfigField({}, "defaults.output", "plain");
    expect(updated.defaults?.output).toBe("plain");
  });

  test("suggests similar key on typo", () => {
    try {
      setConfigField({}, "server.utl", "x");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MnemoniaConfigError);
      expect((err as Error).message).toContain("server.utl");
    }
  });
});

describe("auth file persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mn-auth-"));
    setPathProvider(new TestProfilePathProvider(tmp));
  });

  afterEach(() => {
    resetPathProvider();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("round-trips auth file", () => {
    saveAuthFile({
      provider: "keycloak",
      issuer: "https://auth.example",
      access_token: "tok1",
      refresh_token: "ref1",
      user_email: "user@example.com",
    });
    const loaded = loadAuthFile();
    expect(loaded?.access_token).toBe("tok1");
    expect(loaded?.user_email).toBe("user@example.com");
  });

  test("loadAuthFile returns null when missing", () => {
    expect(loadAuthFile()).toBeNull();
  });

  test("clearAuthFile removes tokens", () => {
    saveAuthFile({ access_token: "gone" });
    clearAuthFile();
    expect(loadAuthFile()).toBeNull();
  });

  test("loadMnemoniaConfigFile returns empty object when missing", () => {
    expect(loadMnemoniaConfigFile()).toEqual({});
  });
});
