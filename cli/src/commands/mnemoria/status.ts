import { Command } from "commander";
import { extractGlobalFlags, runCommand } from "./context";
import { emit, emitJson, emitLine, color } from "./output";
import { loadAuthFile } from "./config-loader";
import type { Column } from "./output";
import { EXIT_AUTH, EXIT_CONNECTION, MnemoniaError } from "./errors";

interface StatusRow {
  key: string;
  value: string;
}

export function createStatusCommand(): Command {
  const cmd = new Command("status");
  cmd.description("Check Mnemoria server health, connectivity, and auth state").action(
    runCommand(
      () => extractGlobalFlags(cmd.optsWithGlobals()),
      async (ctx) => {
        let serverReachable = false;
        let serverVersion: string | undefined;
        let serverError: string | undefined;
        try {
          const health = await ctx.client.healthCheck();
          serverReachable = Boolean(health.ready);
          serverVersion = health.version;
        } catch (err) {
          serverError = err instanceof Error ? err.message : "Unknown error contacting server";
        }

        let authInfo: {
          authenticated: boolean;
          provider?: string;
          userEmail?: string;
          tenantId?: string;
          tenantName?: string;
          expiresIn?: number;
          roles?: string[];
        } = { authenticated: false };

        const stored = loadAuthFile();
        if (ctx.config.auth.mode === "disabled") {
          authInfo = { authenticated: true, provider: "disabled" };
        } else if (process.env.MN_ACCESS_TOKEN) {
          authInfo = { authenticated: true, provider: "env" };
        } else if (stored?.access_token) {
          const expiry = stored.token_expiry ? Date.parse(stored.token_expiry) : NaN;
          const expiresIn = Number.isFinite(expiry)
            ? Math.max(0, Math.floor((expiry - Date.now()) / 1000))
            : undefined;
          authInfo = {
            authenticated: expiresIn === undefined ? true : expiresIn > 0,
            provider: stored.provider,
            userEmail: stored.user_email,
            tenantId: stored.tenant_id,
            tenantName: stored.tenant_name,
            roles: stored.roles,
            expiresIn,
          };
        }

        let palaceCount: number | undefined;
        let defaultPalaceId: string | undefined;
        if (serverReachable && authInfo.authenticated) {
          try {
            const palaces = await ctx.client.listPalaces({ limit: 100 });
            palaceCount = palaces.total ?? palaces.items.length;
            if (ctx.config.defaults.palace) {
              const name = ctx.config.defaults.palace.toLowerCase();
              const match = palaces.items.find(
                (p) => p.id === ctx.config.defaults.palace || p.name.toLowerCase() === name
              );
              if (match) defaultPalaceId = match.id;
            }
          } catch {
            /* ignore */
          }
        }

        if (ctx.out.mode === "json") {
          emitJson({
            server: {
              url: ctx.config.server.url,
              reachable: serverReachable,
              version: serverVersion,
              error: serverError,
            },
            auth: authInfo,
            palaces: palaceCount,
            defaults: {
              palace: ctx.config.defaults.palace || null,
              palace_id: defaultPalaceId || null,
              wing: ctx.config.defaults.wing || null,
              room: ctx.config.defaults.room || null,
              language: ctx.config.defaults.language,
              output: ctx.config.defaults.output,
            },
          });
        } else {
          const check = serverReachable
            ? color(ctx.out, "green", "✓ reachable")
            : color(ctx.out, "red", `✗ ${serverError || "unreachable"}`);
          emitLine(ctx.out, `Server:    ${ctx.config.server.url}  ${check}`);
          if (serverVersion) emitLine(ctx.out, `Version:   ${serverVersion}`);
          const authLabel =
            ctx.config.auth.mode === "disabled"
              ? "disabled (noop auth)"
              : authInfo.authenticated
                ? `${authInfo.provider || "oidc"}${
                    authInfo.expiresIn !== undefined
                      ? ` (valid, expires in ${formatDuration(authInfo.expiresIn)})`
                      : " (valid)"
                  }`
                : "not authenticated";
          emitLine(ctx.out, `Auth:      ${authLabel}`);
          if (authInfo.userEmail) emitLine(ctx.out, `User:      ${authInfo.userEmail}`);
          if (authInfo.tenantName || authInfo.tenantId) {
            emitLine(
              ctx.out,
              `Tenant:    ${authInfo.tenantName || ""}${
                authInfo.tenantId ? ` (${authInfo.tenantId})` : ""
              }`
            );
          }
          if (palaceCount !== undefined) emitLine(ctx.out, `Palaces:   ${palaceCount}`);
          emitLine(ctx.out, "");
          const rows: StatusRow[] = [
            { key: "Palace", value: ctx.config.defaults.palace || "(none)" },
            { key: "Wing", value: ctx.config.defaults.wing || "(none)" },
            { key: "Room", value: ctx.config.defaults.room || "(none)" },
            { key: "Language", value: ctx.config.defaults.language },
            { key: "Output", value: ctx.config.defaults.output },
          ];
          const cols: Column<StatusRow>[] = [
            { header: "DEFAULT", get: (r) => r.key },
            { header: "VALUE", get: (r) => r.value },
          ];
          emit(ctx.out, rows, cols);
        }

        if (!serverReachable) {
          throw new MnemoniaError(
            "Server is not reachable",
            "Check MN_SERVER_URL and that the Mnemoria server is running.",
            undefined,
            EXIT_CONNECTION
          );
        }
        if (!authInfo.authenticated) {
          throw new MnemoniaError(
            "Not authenticated",
            "Run 'heretic-cli mnemoria config login' to authenticate.",
            undefined,
            EXIT_AUTH
          );
        }
      }
    )
  );
  return cmd;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
