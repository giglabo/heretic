import { existsSync, mkdirSync, chmodSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { getHereticDir } from "../../utils/settings";
import { readYamlFile, writeYamlFile } from "../../utils/yaml";
import { getLogger } from "../../logger";
import { MnemoniaConfigError } from "./errors";

const logger = getLogger();

/**
 * On-disk schema for ~/.heretic/mnemoria/config.yaml. Every field is optional
 * so users can start with an empty file; defaults are filled in by `effective`.
 */
export interface MnemoniaConfigFile {
  server?: {
    url?: string;
    timeout?: number;
    retry?: { attempts?: number; delay?: number };
  };
  auth?: {
    mode?: "oidc" | "token_script" | "disabled";
    provider?: "keycloak" | "auth0";
    issuer?: string;
    client_id?: string;
    token_script?: string;
  };
  defaults?: {
    palace?: string;
    language?: string;
    output?: "table" | "json" | "plain";
    page_size?: number;
    wing?: string;
    room?: string;
  };
  output?: {
    color?: "auto" | "always" | "never";
    timestamps?: "relative" | "absolute";
    ids?: "short" | "full";
  };
}

export interface EffectiveMnemoniaConfig {
  profile: string;
  server: {
    url: string;
    timeout: number;
    retry: { attempts: number; delay: number };
  };
  auth: {
    mode: "oidc" | "token_script" | "disabled";
    provider: "keycloak" | "auth0";
    issuer: string;
    client_id: string;
    token_script: string;
  };
  defaults: {
    palace: string;
    language: string;
    output: "table" | "json" | "plain";
    page_size: number;
    wing: string;
    room: string;
  };
  output: {
    color: "auto" | "always" | "never";
    timestamps: "relative" | "absolute";
    ids: "short" | "full";
  };
}

export interface MnemoniaAuthFile {
  provider?: "keycloak" | "auth0";
  issuer?: string;
  client_id?: string;
  login_method?: "pkce" | "pkce_forwarded" | "device_flow";
  access_token?: string;
  refresh_token?: string;
  token_expiry?: string;
  refresh_expiry?: string;
  user_email?: string;
  user_id?: string;
  tenant_id?: string;
  tenant_name?: string;
  roles?: string[];
}

const DEFAULTS: EffectiveMnemoniaConfig = {
  profile: "default",
  server: {
    url: "http://localhost:3000",
    timeout: 30000,
    retry: { attempts: 3, delay: 1000 },
  },
  auth: {
    mode: "oidc",
    provider: "keycloak",
    issuer: "",
    client_id: "mnemoria-cli",
    token_script: "",
  },
  defaults: {
    palace: "",
    language: "en",
    output: "table",
    page_size: 20,
    wing: "",
    room: "",
  },
  output: {
    color: "auto",
    timestamps: "relative",
    ids: "short",
  },
};

/**
 * Environment variable names that override config fields. Kept in one place so
 * tests + docs have a single source of truth.
 */
export const ENV_OVERRIDES = {
  "server.url": "MN_SERVER_URL",
  "server.timeout": "MN_SERVER_TIMEOUT",
  "auth.mode": "MN_AUTH_MODE",
  "auth.issuer": "MN_AUTH_ISSUER",
  "auth.client_id": "MN_AUTH_CLIENT_ID",
  "defaults.palace": "MN_DEFAULT_PALACE",
  "defaults.language": "MN_DEFAULT_LANGUAGE",
  "defaults.wing": "MN_DEFAULT_WING",
  "defaults.room": "MN_DEFAULT_ROOM",
  "defaults.output": "MN_OUTPUT",
} as const;

export function getMnemoniaDir(): string {
  return join(getHereticDir(), "mnemoria");
}

export function getMnemoniaConfigPath(): string {
  return join(getMnemoniaDir(), "config.yaml");
}

export function getMnemoniaAuthPath(): string {
  return join(getMnemoniaDir(), "auth.yaml");
}

export function getMnemoniaProfilesDir(): string {
  return join(getMnemoniaDir(), "profiles");
}

export function getMnemoniaProfilePath(name: string): string {
  return join(getMnemoniaProfilesDir(), `${name}.yaml`);
}

/**
 * Ensure ~/.heretic/mnemoria/ exists. Called before writing any config.
 */
export function ensureMnemoniaDir(): void {
  const dir = getMnemoniaDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const profilesDir = getMnemoniaProfilesDir();
  if (!existsSync(profilesDir)) mkdirSync(profilesDir, { recursive: true });
}

export function loadMnemoniaConfigFile(): MnemoniaConfigFile {
  const path = getMnemoniaConfigPath();
  if (!existsSync(path)) return {};
  try {
    return readYamlFile<MnemoniaConfigFile>(path) || {};
  } catch (err) {
    logger.warn({ err, path }, "Failed to read mnemoria config.yaml");
    return {};
  }
}

export function saveMnemoniaConfigFile(config: MnemoniaConfigFile): void {
  ensureMnemoniaDir();
  writeYamlFile(getMnemoniaConfigPath(), config);
}

export function loadProfileFile(name: string): MnemoniaConfigFile | null {
  const path = getMnemoniaProfilePath(name);
  if (!existsSync(path)) return null;
  try {
    return readYamlFile<MnemoniaConfigFile>(path) || {};
  } catch (err) {
    logger.warn({ err, path }, `Failed to read mnemoria profile '${name}'`);
    return null;
  }
}

export function listMnemoniaProfiles(): string[] {
  const dir = getMnemoniaProfilesDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load the effective Mnemoria configuration with priority:
 *   CLI overrides > env vars > profile > config.yaml > built-in defaults.
 * CLI overrides are applied by the caller; this returns everything below.
 */
export function loadEffectiveConfig(options?: {
  profile?: string;
  cliOverrides?: {
    serverUrl?: string;
    output?: "table" | "json" | "plain";
    palace?: string;
  };
}): EffectiveMnemoniaConfig {
  const base = loadMnemoniaConfigFile();
  let merged: MnemoniaConfigFile = base;

  // Layer: named profile
  const profileName = options?.profile;
  if (profileName) {
    const profile = loadProfileFile(profileName);
    if (!profile) {
      throw new MnemoniaConfigError(
        `Mnemoria profile '${profileName}' not found`,
        `Expected ${getMnemoniaProfilePath(profileName)}. List profiles: heretic-cli mnemoria config profiles`
      );
    }
    merged = deepMerge(merged, profile);
  }

  // Layer: env vars
  const envLayer = envOverrides();
  merged = deepMerge(merged, envLayer);

  // Fill defaults
  const effective: EffectiveMnemoniaConfig = {
    profile: profileName || "default",
    server: {
      url: merged.server?.url ?? DEFAULTS.server.url,
      timeout: merged.server?.timeout ?? DEFAULTS.server.timeout,
      retry: {
        attempts: merged.server?.retry?.attempts ?? DEFAULTS.server.retry.attempts,
        delay: merged.server?.retry?.delay ?? DEFAULTS.server.retry.delay,
      },
    },
    auth: {
      mode: merged.auth?.mode ?? DEFAULTS.auth.mode,
      provider: merged.auth?.provider ?? DEFAULTS.auth.provider,
      issuer: merged.auth?.issuer ?? DEFAULTS.auth.issuer,
      client_id: merged.auth?.client_id ?? DEFAULTS.auth.client_id,
      token_script: merged.auth?.token_script ?? DEFAULTS.auth.token_script,
    },
    defaults: {
      palace: merged.defaults?.palace ?? DEFAULTS.defaults.palace,
      language: merged.defaults?.language ?? DEFAULTS.defaults.language,
      output: merged.defaults?.output ?? DEFAULTS.defaults.output,
      page_size: merged.defaults?.page_size ?? DEFAULTS.defaults.page_size,
      wing: merged.defaults?.wing ?? DEFAULTS.defaults.wing,
      room: merged.defaults?.room ?? DEFAULTS.defaults.room,
    },
    output: {
      color: merged.output?.color ?? DEFAULTS.output.color,
      timestamps: merged.output?.timestamps ?? DEFAULTS.output.timestamps,
      ids: merged.output?.ids ?? DEFAULTS.output.ids,
    },
  };

  // Layer: CLI overrides (highest)
  const overrides = options?.cliOverrides;
  if (overrides?.serverUrl) effective.server.url = overrides.serverUrl;
  if (overrides?.output) effective.defaults.output = overrides.output;
  if (overrides?.palace) effective.defaults.palace = overrides.palace;

  return effective;
}

/**
 * Set a nested field using dot notation (e.g. "server.url"). Validates the
 * path against the known schema keys. Returns the updated config object, which
 * the caller is responsible for saving.
 */
export function setConfigField(
  config: MnemoniaConfigFile,
  keyPath: string,
  value: string
): MnemoniaConfigFile {
  if (!KNOWN_KEYS.has(keyPath)) {
    const suggestion = suggestKey(keyPath);
    throw new MnemoniaConfigError(
      `Unknown config key '${keyPath}'`,
      suggestion
        ? `Did you mean '${suggestion}'?`
        : `Run 'heretic-cli mnemoria config show' to see valid keys.`
    );
  }
  const parsed = parseConfigValue(keyPath, value);
  const next = deepClone(config);
  setNestedField(next as Record<string, unknown>, keyPath.split("."), parsed);
  return next;
}

// ---------- Auth file ----------

export function loadAuthFile(): MnemoniaAuthFile | null {
  // Prefer writable overlay (used inside containers to persist refreshed
  // tokens when the host-mounted auth.yaml is read-only).
  const overlay = join(getMnemoniaDir(), "auth-local.yaml");
  if (existsSync(overlay)) {
    try {
      return readYamlFile<MnemoniaAuthFile>(overlay) || null;
    } catch {
      // fall through to main file
    }
  }

  const path = getMnemoniaAuthPath();
  if (!existsSync(path)) return null;
  try {
    return readYamlFile<MnemoniaAuthFile>(path) || null;
  } catch (err) {
    logger.warn({ err, path }, "Failed to read auth.yaml");
    return null;
  }
}

export function saveAuthFile(auth: MnemoniaAuthFile): void {
  ensureMnemoniaDir();
  const path = getMnemoniaAuthPath();
  const overlay = join(getMnemoniaDir(), "auth-local.yaml");

  // Inside a container where auth.yaml is mounted read-only, we can still
  // write to auth-local.yaml as the effective token store.
  try {
    writeYamlFile(path, auth);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* chmod is best-effort on Windows */
    }
  } catch (err) {
    logger.debug({ err }, "auth.yaml not writable, using overlay");
    writeYamlFile(overlay, auth);
    try {
      chmodSync(overlay, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function clearAuthFile(): void {
  const paths = [getMnemoniaAuthPath(), join(getMnemoniaDir(), "auth-local.yaml")];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch (err) {
        logger.warn({ err, path: p }, "Failed to remove auth file");
      }
    }
  }
}

// ---------- Helpers ----------

const KNOWN_KEYS = new Set<string>([
  "server.url",
  "server.timeout",
  "server.retry.attempts",
  "server.retry.delay",
  "auth.mode",
  "auth.provider",
  "auth.issuer",
  "auth.client_id",
  "auth.token_script",
  "defaults.palace",
  "defaults.language",
  "defaults.output",
  "defaults.page_size",
  "defaults.wing",
  "defaults.room",
  "output.color",
  "output.timestamps",
  "output.ids",
]);

function suggestKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const known of KNOWN_KEYS) {
    const score = levenshtein(lower, known.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = known;
    }
  }
  return bestScore <= 3 ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array(b.length + 1)
    .fill(0)
    .map((_, i) => i);
  const curr = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function parseConfigValue(keyPath: string, value: string): unknown {
  // Numeric keys
  if (
    keyPath === "server.timeout" ||
    keyPath === "server.retry.attempts" ||
    keyPath === "server.retry.delay" ||
    keyPath === "defaults.page_size"
  ) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new MnemoniaConfigError(`Value for '${keyPath}' must be a number, got '${value}'`);
    }
    return n;
  }
  // Enum validation
  if (keyPath === "defaults.output" && !["table", "json", "plain"].includes(value)) {
    throw new MnemoniaConfigError(
      `Invalid value '${value}' for 'defaults.output'`,
      "Allowed: table, json, plain"
    );
  }
  if (keyPath === "auth.mode" && !["oidc", "token_script", "disabled"].includes(value)) {
    throw new MnemoniaConfigError(
      `Invalid value '${value}' for 'auth.mode'`,
      "Allowed: oidc, token_script, disabled"
    );
  }
  if (keyPath === "auth.provider" && !["keycloak", "auth0"].includes(value)) {
    throw new MnemoniaConfigError(
      `Invalid value '${value}' for 'auth.provider'`,
      "Allowed: keycloak, auth0"
    );
  }
  if (keyPath === "output.color" && !["auto", "always", "never"].includes(value)) {
    throw new MnemoniaConfigError(
      `Invalid value '${value}' for 'output.color'`,
      "Allowed: auto, always, never"
    );
  }
  if (keyPath === "output.timestamps" && !["relative", "absolute"].includes(value)) {
    throw new MnemoniaConfigError(
      `Invalid value '${value}' for 'output.timestamps'`,
      "Allowed: relative, absolute"
    );
  }
  if (keyPath === "output.ids" && !["short", "full"].includes(value)) {
    throw new MnemoniaConfigError(
      `Invalid value '${value}' for 'output.ids'`,
      "Allowed: short, full"
    );
  }
  return value;
}

function setNestedField(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const child = cursor[key];
    if (typeof child !== "object" || child === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function envOverrides(): MnemoniaConfigFile {
  const out: MnemoniaConfigFile = {};
  const env = process.env;
  if (env.MN_SERVER_URL) out.server = { ...out.server, url: env.MN_SERVER_URL };
  if (env.MN_SERVER_TIMEOUT) {
    const n = Number(env.MN_SERVER_TIMEOUT);
    if (Number.isFinite(n)) out.server = { ...out.server, timeout: n };
  }
  if (env.MN_AUTH_MODE) {
    const mode = env.MN_AUTH_MODE as "oidc" | "token_script" | "disabled";
    if (["oidc", "token_script", "disabled"].includes(mode)) {
      out.auth = { ...out.auth, mode };
    }
  }
  if (env.MN_AUTH_ISSUER) out.auth = { ...out.auth, issuer: env.MN_AUTH_ISSUER };
  if (env.MN_AUTH_CLIENT_ID) out.auth = { ...out.auth, client_id: env.MN_AUTH_CLIENT_ID };
  if (env.MN_DEFAULT_PALACE) out.defaults = { ...out.defaults, palace: env.MN_DEFAULT_PALACE };
  if (env.MN_DEFAULT_LANGUAGE)
    out.defaults = { ...out.defaults, language: env.MN_DEFAULT_LANGUAGE };
  if (env.MN_DEFAULT_WING) out.defaults = { ...out.defaults, wing: env.MN_DEFAULT_WING };
  if (env.MN_DEFAULT_ROOM) out.defaults = { ...out.defaults, room: env.MN_DEFAULT_ROOM };
  if (env.MN_OUTPUT && ["table", "json", "plain"].includes(env.MN_OUTPUT)) {
    out.defaults = {
      ...out.defaults,
      output: env.MN_OUTPUT as "table" | "json" | "plain",
    };
  }
  return out;
}

function deepMerge<T>(base: T, over: T): T {
  const out: Record<string, unknown> = {
    ...(base as unknown as Record<string, unknown>),
  };
  const overMap = over as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overMap)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      typeof existing === "object" &&
      existing !== null &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
