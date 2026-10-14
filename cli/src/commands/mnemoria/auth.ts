import { createHash, randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { getLogger } from "../../logger";
import {
  loadAuthFile,
  saveAuthFile,
  type EffectiveMnemoniaConfig,
  type MnemoniaAuthFile,
} from "./config-loader";
import { MnemoniaAuthError, MnemoniaConfigError } from "./errors";

const logger = getLogger();

/**
 * Factory for the token provider passed to MnemoniaClient. Each invocation of
 * the returned function resolves the current bearer token with this priority:
 *
 *   1. `MN_ACCESS_TOKEN` environment variable
 *   2. `auth.token_script` (execute; stdout is the token)
 *   3. Stored `auth.yaml` (refreshed if expired and refresh_token is valid)
 *
 * Returning `null` is valid (e.g. `auth.mode = "disabled"`); the client will
 * send the request unauthenticated.
 */
export function createTokenProvider(config: EffectiveMnemoniaConfig): () => Promise<string | null> {
  return async () => {
    if (process.env.MN_ACCESS_TOKEN) {
      return process.env.MN_ACCESS_TOKEN;
    }

    if (config.auth.mode === "disabled") {
      return null;
    }

    if (config.auth.mode === "token_script" && config.auth.token_script) {
      return executeTokenScript(config.auth.token_script);
    }

    const stored = loadAuthFile();
    if (!stored?.access_token) return null;

    if (isExpired(stored.token_expiry)) {
      if (stored.refresh_token && !isExpired(stored.refresh_expiry)) {
        const refreshed = await refreshAccessToken(config, stored);
        saveAuthFile(refreshed);
        return refreshed.access_token ?? null;
      }
      throw new MnemoniaAuthError(
        "Stored access token is expired. Run 'heretic-cli mnemoria config login'."
      );
    }

    return stored.access_token;
  };
}

export function isExpired(isoDate?: string): boolean {
  if (!isoDate) return true;
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return true;
  // 30 second clock skew buffer
  return t - 30_000 < Date.now();
}

/**
 * Execute a shell script and return its trimmed stdout as a bearer token.
 * Supports path expansion (~ → $HOME) and .sh / .cmd / .ps1 scripts.
 */
export function executeTokenScript(scriptPath: string): string {
  let path = scriptPath.trim();
  if (path.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    path = path.replace(/^~/, home);
  }

  if (!existsSync(path)) {
    throw new MnemoniaConfigError(
      `Token script not found: ${path}`,
      "Update auth.token_script in ~/.heretic/mnemoria/config.yaml."
    );
  }

  try {
    let cmd: string;
    if (path.endsWith(".ps1")) {
      cmd = `powershell -ExecutionPolicy Bypass -File "${path}"`;
    } else if (path.endsWith(".cmd") || path.endsWith(".bat")) {
      cmd = `cmd /c "${path}"`;
    } else {
      cmd = `"${path}"`;
    }
    const out = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      shell: process.platform === "win32" ? undefined : "/bin/bash",
    });
    const token = out.trim();
    if (!token) {
      throw new MnemoniaAuthError(`Token script '${path}' produced empty output`);
    }
    return token;
  } catch (err) {
    if (err instanceof MnemoniaAuthError) throw err;
    throw new MnemoniaAuthError(
      `Failed to execute token script '${path}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Exchange a refresh_token for a fresh access_token against the configured
 * OIDC issuer. Returns an updated MnemoniaAuthFile that the caller should
 * persist.
 */
export async function refreshAccessToken(
  config: EffectiveMnemoniaConfig,
  stored: MnemoniaAuthFile
): Promise<MnemoniaAuthFile> {
  const issuer = stored.issuer || config.auth.issuer;
  const clientId = stored.client_id || config.auth.client_id;
  if (!issuer) {
    throw new MnemoniaAuthError("Cannot refresh token: no auth.issuer configured");
  }
  if (!stored.refresh_token) {
    throw new MnemoniaAuthError("Cannot refresh token: no refresh_token stored");
  }

  const tokenUrl = buildTokenUrl(issuer, stored.provider || config.auth.provider);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: clientId,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new MnemoniaAuthError(
      `Refresh token failed (${response.status}): ${detail.substring(0, 200)}`
    );
  }

  const json = (await response.json()) as TokenEndpointResponse;
  return mergeStoredTokens(stored, json);
}

// ---------- PKCE flow ----------

export interface PkceLoginOptions {
  issuer: string;
  clientId: string;
  provider: "keycloak" | "auth0";
  scope?: string;
  redirectBind?: string; // default 127.0.0.1
  redirectPort?: number; // explicit port (0 = random)
  openBrowser?: (url: string) => Promise<void>;
}

export interface LoginResult {
  tokens: MnemoniaAuthFile;
}

/**
 * Run the Authorization Code + PKCE flow against the configured IdP.
 * Spawns a local HTTP server on 127.0.0.1, opens the authorization URL in the
 * default browser, waits for the redirect, and exchanges the code for tokens.
 */
export async function loginWithPkce(options: PkceLoginOptions): Promise<LoginResult> {
  const {
    issuer,
    clientId,
    provider,
    scope = "openid profile email offline_access",
    redirectBind = "127.0.0.1",
    redirectPort = 0,
  } = options;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  const { code, redirectUri, close } = await runCallbackServer({
    bind: redirectBind,
    port: redirectPort,
    expectedState: state,
  });

  try {
    const authUrl = new URL(buildAuthorizeUrl(issuer, provider));
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    if (options.openBrowser) {
      await options.openBrowser(authUrl.toString());
    } else {
      tryOpenBrowser(authUrl.toString());
    }

    logger.info({ redirectUri }, "Waiting for browser authorization callback");
    const authCode = await code;

    const tokenResponse = await exchangeCode({
      issuer,
      clientId,
      provider,
      code: authCode,
      codeVerifier,
      redirectUri,
    });
    const stored = mergeStoredTokens(
      {
        provider,
        issuer,
        client_id: clientId,
        login_method: "pkce",
      },
      tokenResponse
    );
    return { tokens: stored };
  } finally {
    close();
  }
}

interface CallbackServerHandle {
  code: Promise<string>;
  redirectUri: string;
  close: () => void;
}

function runCallbackServer(opts: {
  bind: string;
  port: number;
  expectedState: string;
}): Promise<CallbackServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400).end("Missing URL");
        return;
      }
      const u = new URL(req.url, `http://${opts.bind}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const err = u.searchParams.get("error");
      if (err) {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end(`<html><body><h1>Authentication failed</h1><p>${escapeHtml(err)}</p></body></html>`);
        codeReject(new MnemoniaAuthError(`Authorization error: ${err}`));
        return;
      }
      const state = u.searchParams.get("state");
      if (state !== opts.expectedState) {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end(`<html><body><h1>State mismatch</h1></body></html>`);
        codeReject(new MnemoniaAuthError("State mismatch in OAuth callback"));
        return;
      }
      const code = u.searchParams.get("code");
      if (!code) {
        res.writeHead(400).end("Missing code");
        codeReject(new MnemoniaAuthError("Missing authorization code"));
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          `<html><body><h1>Authentication complete</h1><p>You can close this tab.</p></body></html>`
        );
      codeResolve(code);
    });

    let codeResolve!: (code: string) => void;
    let codeReject!: (err: Error) => void;
    const code = new Promise<string>((res2, rej2) => {
      codeResolve = res2;
      codeReject = rej2;
    });

    server.listen(opts.port, opts.bind, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new MnemoniaAuthError("Failed to start callback server"));
        return;
      }
      const actualPort = address.port;
      const host = opts.bind === "0.0.0.0" ? "localhost" : opts.bind;
      const redirectUri = `http://${host}:${actualPort}/callback`;
      resolve({
        code,
        redirectUri,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
    server.on("error", (err) => reject(err));
  });
}

// ---------- Device flow ----------

export interface DeviceFlowOptions {
  issuer: string;
  clientId: string;
  provider: "keycloak" | "auth0";
  scope?: string;
  onUserCode?: (verification: {
    verificationUri: string;
    verificationUriComplete?: string;
    userCode: string;
    expiresIn: number;
  }) => void;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in: number;
}

/**
 * Run the OAuth 2.0 Device Authorization Grant (RFC 8628). Prints the
 * verification URL + user code via `onUserCode`, then polls the token
 * endpoint until the user completes auth on any device.
 */
export async function loginWithDeviceFlow(options: DeviceFlowOptions): Promise<LoginResult> {
  const {
    issuer,
    clientId,
    provider,
    scope = "openid profile email offline_access",
    onUserCode,
  } = options;

  const deviceUrl = buildDeviceUrl(issuer, provider);
  const tokenUrl = buildTokenUrl(issuer, provider);

  const deviceResp = await fetch(deviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  if (!deviceResp.ok) {
    const detail = await deviceResp.text();
    throw new MnemoniaAuthError(
      `Device flow initialization failed (${deviceResp.status}): ${detail.substring(0, 200)}`
    );
  }
  const device = (await deviceResp.json()) as DeviceCodeResponse;

  if (onUserCode) {
    onUserCode({
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      userCode: device.user_code,
      expiresIn: device.expires_in,
    });
  }

  let pollMs = Math.max(1, device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const tokenResp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: clientId,
      }),
    });
    if (tokenResp.ok) {
      const tokens = (await tokenResp.json()) as TokenEndpointResponse;
      const stored = mergeStoredTokens(
        {
          provider,
          issuer,
          client_id: clientId,
          login_method: "device_flow",
        },
        tokens
      );
      return { tokens: stored };
    }
    let errCode = "";
    try {
      const err = (await tokenResp.json()) as { error?: string };
      errCode = err.error || "";
    } catch {
      /* ignore */
    }
    if (errCode === "authorization_pending") continue;
    if (errCode === "slow_down") {
      pollMs += 5_000;
      continue;
    }
    if (errCode === "access_denied") {
      throw new MnemoniaAuthError("Access denied by user");
    }
    if (errCode === "expired_token") {
      throw new MnemoniaAuthError("Device code expired. Retry 'config login'.");
    }
    throw new MnemoniaAuthError(`Device flow error: ${errCode || tokenResp.statusText}`);
  }
  throw new MnemoniaAuthError("Device flow timed out");
}

// ---------- PKCE helpers ----------

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function computeCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---------- Token exchange ----------

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
  id_token?: string;
}

async function exchangeCode(opts: {
  issuer: string;
  clientId: string;
  provider: "keycloak" | "auth0";
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenEndpointResponse> {
  const url = buildTokenUrl(opts.issuer, opts.provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new MnemoniaAuthError(
      `Token exchange failed (${response.status}): ${detail.substring(0, 200)}`
    );
  }
  return (await response.json()) as TokenEndpointResponse;
}

function mergeStoredTokens(
  base: MnemoniaAuthFile,
  tokens: TokenEndpointResponse
): MnemoniaAuthFile {
  const now = Date.now();
  const accessExpiry = tokens.expires_in
    ? new Date(now + tokens.expires_in * 1000).toISOString()
    : base.token_expiry;
  const refreshExpiry = tokens.refresh_expires_in
    ? new Date(now + tokens.refresh_expires_in * 1000).toISOString()
    : base.refresh_expiry;

  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
  const userEmail = typeof claims?.email === "string" ? (claims.email as string) : base.user_email;
  const userId = typeof claims?.sub === "string" ? (claims.sub as string) : base.user_id;
  const tenantId =
    typeof claims?.tenant_id === "string"
      ? (claims.tenant_id as string)
      : typeof claims?.org_id === "string"
        ? (claims.org_id as string)
        : base.tenant_id;
  const tenantName =
    typeof claims?.tenant_name === "string"
      ? (claims.tenant_name as string)
      : typeof claims?.org_name === "string"
        ? (claims.org_name as string)
        : base.tenant_name;
  const roles = Array.isArray(claims?.roles) ? (claims.roles as string[]) : base.roles;

  return {
    ...base,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? base.refresh_token,
    token_expiry: accessExpiry,
    refresh_expiry: refreshExpiry,
    user_email: userEmail,
    user_id: userId,
    tenant_id: tenantId,
    tenant_name: tenantName,
    roles,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf-8"
    );
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------- URL builders ----------

function buildAuthorizeUrl(issuer: string, provider: "keycloak" | "auth0"): string {
  const base = issuer.replace(/\/+$/, "");
  if (provider === "auth0") return `${base}/authorize`;
  return `${base}/protocol/openid-connect/auth`;
}

function buildTokenUrl(issuer: string, provider: "keycloak" | "auth0"): string {
  const base = issuer.replace(/\/+$/, "");
  if (provider === "auth0") return `${base}/oauth/token`;
  return `${base}/protocol/openid-connect/token`;
}

function buildDeviceUrl(issuer: string, provider: "keycloak" | "auth0"): string {
  const base = issuer.replace(/\/+$/, "");
  if (provider === "auth0") return `${base}/oauth/device/code`;
  return `${base}/protocol/openid-connect/auth/device`;
}

// ---------- Environment detection ----------

export function isInsideContainer(): boolean {
  if (process.env.MN_CONTAINER === "1") return true;
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export function canOpenBrowser(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform === "win32") return true;
  if (process.platform === "linux") {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return false;
}

export function selectAuthMethod(): "pkce" | "pkce_forwarded" | "device_flow" {
  if (!isInsideContainer()) {
    return canOpenBrowser() ? "pkce" : "device_flow";
  }
  if (process.env.MN_AUTH_CALLBACK_PORT) return "pkce_forwarded";
  return "device_flow";
}

function tryOpenBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (err) {
    logger.debug({ err }, "Failed to open browser; user must click URL");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
