import { Command } from "commander";
import { extractGlobalFlags, runCommand, type MnemoniaGlobalFlags } from "./context";
import {
  clearAuthFile,
  ensureMnemoniaDir,
  getMnemoniaAuthPath,
  getMnemoniaConfigPath,
  listMnemoniaProfiles,
  loadMnemoniaConfigFile,
  saveAuthFile,
  saveMnemoniaConfigFile,
  setConfigField,
} from "./config-loader";
import { emit, emitJson, emitLine, color } from "./output";
import type { Column } from "./output";
import {
  canOpenBrowser,
  isInsideContainer,
  loginWithDeviceFlow,
  loginWithPkce,
  selectAuthMethod,
} from "./auth";
import { MnemoniaConfigError } from "./errors";
import { resolvePalace } from "./palace-resolver";
import { loadEffectiveConfig } from "./config-loader";

export function createConfigCommand(): Command {
  const cfg = new Command("config");
  cfg.description("Manage Mnemoria CLI configuration and authentication");

  // config show
  const showCmd = new Command("show");
  showCmd.description("Display effective configuration").action(
    runCommand(
      () => extractGlobalFlags(cfg.optsWithGlobals()),
      async (ctx) => {
        if (ctx.out.mode === "json") {
          emitJson({
            profile: ctx.config.profile,
            server: ctx.config.server,
            auth: {
              mode: ctx.config.auth.mode,
              provider: ctx.config.auth.provider,
              issuer: ctx.config.auth.issuer || null,
              client_id: ctx.config.auth.client_id,
              token_script: ctx.config.auth.token_script || null,
            },
            defaults: ctx.config.defaults,
            output: ctx.config.output,
          });
          return;
        }
        emitLine(ctx.out, `Server:     ${ctx.config.server.url}`);
        emitLine(ctx.out, `Auth mode:  ${ctx.config.auth.mode} (${ctx.config.auth.provider})`);
        emitLine(ctx.out, `Profile:    ${ctx.config.profile}`);
        emitLine(ctx.out, "");
        const rows = [
          { k: "Palace", v: ctx.config.defaults.palace || "(none)" },
          { k: "Language", v: ctx.config.defaults.language },
          { k: "Output", v: ctx.config.defaults.output },
          { k: "Page size", v: String(ctx.config.defaults.page_size) },
          { k: "Wing", v: ctx.config.defaults.wing || "(none)" },
          { k: "Room", v: ctx.config.defaults.room || "(none)" },
        ];
        const cols: Column<{ k: string; v: string }>[] = [
          { header: "DEFAULT", get: (r) => r.k },
          { header: "VALUE", get: (r) => r.v },
        ];
        emit(ctx.out, rows, cols);
        emitLine(ctx.out, "");
        emitLine(ctx.out, `Config file: ${getMnemoniaConfigPath()}`);
        emitLine(ctx.out, `Auth file:   ${getMnemoniaAuthPath()}`);
      }
    )
  );
  cfg.addCommand(showCmd);

  // config set
  const setCmd = new Command("set");
  setCmd
    .description("Set a configuration value")
    .argument("<key>", "Config key in dot notation (e.g. server.url)")
    .argument("<value>", "Value to set")
    .action(async (key: string, value: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const current = loadMnemoniaConfigFile();
          const updated = setConfigField(current, key, value);
          saveMnemoniaConfigFile(updated);
          emitLine(ctx.out, `Set ${key} = ${value}`);
        }
      )();
    });
  cfg.addCommand(setCmd);

  // config login
  const loginCmd = new Command("login");
  loginCmd
    .description("Authenticate via OIDC (PKCE by default; device flow as fallback)")
    .option("--device-flow", "Force device authorization flow")
    .option("--provider <name>", "Override auth provider: keycloak | auth0")
    .option("--issuer <url>", "Override OIDC issuer URL")
    .option("--client-id <id>", "Override OIDC client ID")
    .action(async (options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const provider =
            (options.provider as "keycloak" | "auth0" | undefined) || ctx.config.auth.provider;
          const issuer = (options.issuer as string | undefined) || ctx.config.auth.issuer;
          const clientId = (options.clientId as string | undefined) || ctx.config.auth.client_id;
          if (!issuer) {
            throw new MnemoniaConfigError(
              "No OIDC issuer configured",
              "Run: heretic-cli mnemoria config set auth.issuer <url>"
            );
          }

          const force: boolean = Boolean(options.deviceFlow);
          const method = force ? "device_flow" : selectAuthMethod();

          ensureMnemoniaDir();

          if (method === "device_flow") {
            emitLine(ctx.out, color(ctx.out, "cyan", "Using device authorization flow..."));
            const result = await loginWithDeviceFlow({
              issuer,
              clientId,
              provider,
              onUserCode: (v) => {
                emitLine(ctx.out, "");
                emitLine(ctx.out, `Visit:  ${v.verificationUri}`);
                emitLine(ctx.out, `Code:   ${color(ctx.out, "bold", v.userCode)}`);
                if (v.verificationUriComplete) {
                  emitLine(ctx.out, "");
                  emitLine(ctx.out, `Or directly: ${v.verificationUriComplete}`);
                }
                emitLine(ctx.out, "");
                emitLine(
                  ctx.out,
                  `Waiting for authorization (expires in ${Math.round(v.expiresIn / 60)}m)...`
                );
              },
            });
            saveAuthFile(result.tokens);
            emitLine(
              ctx.out,
              color(
                ctx.out,
                "green",
                `✓ Authenticated${
                  result.tokens.user_email ? ` as ${result.tokens.user_email}` : ""
                }`
              )
            );
            emitLine(ctx.out, `Tokens saved to ${getMnemoniaAuthPath()}`);
            return;
          }

          // PKCE (regular or forwarded)
          const bind = method === "pkce_forwarded" ? "0.0.0.0" : "127.0.0.1";
          const port =
            method === "pkce_forwarded" && process.env.MN_AUTH_CALLBACK_PORT
              ? Number(process.env.MN_AUTH_CALLBACK_PORT)
              : 0;

          emitLine(ctx.out, color(ctx.out, "cyan", "Opening browser for login..."));
          if (method === "pkce_forwarded") {
            emitLine(ctx.out, `Listening on http://${bind}:${port}/callback (forwarded from host)`);
            emitLine(ctx.out, "Open the printed URL on the host machine to complete login.");
          }

          const result = await loginWithPkce({
            issuer,
            clientId,
            provider,
            redirectBind: bind,
            redirectPort: port,
          });
          saveAuthFile(result.tokens);
          emitLine(
            ctx.out,
            color(
              ctx.out,
              "green",
              `✓ Authenticated${result.tokens.user_email ? ` as ${result.tokens.user_email}` : ""}`
            )
          );
          if (result.tokens.tenant_name) {
            emitLine(ctx.out, `Tenant: ${result.tokens.tenant_name}`);
          }
          if (result.tokens.roles?.length) {
            emitLine(ctx.out, `Roles:  ${result.tokens.roles.join(", ")}`);
          }
          emitLine(ctx.out, `Tokens saved to ${getMnemoniaAuthPath()}`);
        }
      )();
    });
  cfg.addCommand(loginCmd);

  // config logout
  const logoutCmd = new Command("logout");
  logoutCmd.description("Remove stored tokens").action(async (_opts, command: Command) => {
    await runCommand(
      () => extractGlobalFlags(command.optsWithGlobals()),
      async (ctx) => {
        clearAuthFile();
        emitLine(ctx.out, "Tokens removed.");
      }
    )();
  });
  cfg.addCommand(logoutCmd);

  // config profiles
  const profilesCmd = new Command("profiles");
  profilesCmd
    .description("List available connection profiles")
    .action(async (_opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const names = ["default", ...listMnemoniaProfiles()];
          const seen = new Set<string>();
          const rows: Array<{ name: string; server: string; auth: string }> = [];
          for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            try {
              const effective =
                name === "default"
                  ? loadEffectiveConfig({})
                  : loadEffectiveConfig({ profile: name });
              rows.push({
                name,
                server: effective.server.url,
                auth: `${effective.auth.mode} (${effective.auth.provider})`,
              });
            } catch {
              rows.push({ name, server: "(invalid)", auth: "-" });
            }
          }
          const cols: Column<(typeof rows)[number]>[] = [
            { header: "PROFILE", get: (r) => r.name },
            { header: "SERVER", get: (r) => r.server },
            { header: "AUTH", get: (r) => r.auth },
          ];
          emit(ctx.out, rows, cols);
        }
      )();
    });
  cfg.addCommand(profilesCmd);

  // config use-palace
  const usePalaceCmd = new Command("use-palace");
  usePalaceCmd
    .description("Set default palace")
    .argument("<id-or-name>", "Palace ID or name")
    .action(async (idOrName: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palace = await resolvePalace(ctx.client, idOrName);
          const current = loadMnemoniaConfigFile();
          const updated = setConfigField(current, "defaults.palace", palace.name);
          saveMnemoniaConfigFile(updated);
          emitLine(
            ctx.out,
            `Default palace set to "${palace.name}" (${palace.id.substring(0, 8)})`
          );
        }
      )();
    });
  cfg.addCommand(usePalaceCmd);

  // config diagnose
  const diagnoseCmd = new Command("diagnose");
  diagnoseCmd
    .description("Print environment detection for auth flow")
    .action(async (_opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const info = {
            in_container: isInsideContainer(),
            can_open_browser: canOpenBrowser(),
            selected_method: selectAuthMethod(),
            auth_callback_port: process.env.MN_AUTH_CALLBACK_PORT || null,
            display: process.env.DISPLAY || null,
          };
          if (ctx.out.mode === "json") {
            emitJson(info);
            return;
          }
          for (const [k, v] of Object.entries(info)) {
            emitLine(ctx.out, `${k}: ${String(v)}`);
          }
        }
      )();
    });
  cfg.addCommand(diagnoseCmd);

  return cfg;
}

// Re-export for testing
export { extractGlobalFlags };
export type { MnemoniaGlobalFlags };
