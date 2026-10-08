import { Command } from "commander";
import inquirer from "inquirer";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { collectAllPages, pageEnvelope } from "./pagination";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emit, emitJson, emitLine, formatId, formatTimestamp, color } from "./output";
import type { Column } from "./output";
import {
  EXIT_CANCELLED,
  MnemoniaAmbiguousError,
  MnemoniaError,
  MnemoniaNotFoundError,
} from "./errors";
import type { WingResponse } from "./types";

async function resolveWing(
  ctx: MnemoniaCommandContext,
  palaceId: string,
  identifier: string
): Promise<WingResponse> {
  // UUID → fetch direct
  const uuidLike = /^[0-9a-f-]{36}$/i.test(identifier);
  if (uuidLike) return ctx.client.getWing(palaceId, identifier);

  const wings = await collectAllPages<WingResponse>(
    (req) => ctx.client.listWings(palaceId, req),
    100
  );
  const lower = identifier.toLowerCase();
  const exact = wings.filter((w) => w.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new MnemoniaAmbiguousError(
      "wing",
      identifier,
      exact.map((w) => w.name)
    );
  }
  throw new MnemoniaNotFoundError("Wing", identifier);
}

function columns(ctx: MnemoniaCommandContext): Column<WingResponse>[] {
  return [
    { header: "ID", get: (w) => formatId(w.id, ctx.out) },
    { header: "NAME", get: (w) => w.name },
    { header: "ROOMS", get: (w) => String(w.room_count ?? "—"), align: "right" },
    { header: "DRAWERS", get: (w) => String(w.drawer_count ?? "—"), align: "right" },
    { header: "SORT", get: (w) => String(w.sort_order ?? 0), align: "right" },
    { header: "CREATED", get: (w) => formatTimestamp(w.created_at, ctx.out) },
  ];
}

export function createWingCommand(): Command {
  const wing = new Command("wing");
  wing.description("Manage wings");

  const createCmd = new Command("create");
  createCmd
    .description("Create a wing")
    .requiredOption("--name <name>", "Wing name")
    .option("--description <text>", "Description")
    .option("--sort-order <n>", "Sort order", parseInt)
    .action(async (options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const result = await ctx.client.createWing(palaceId, {
            name: options.name as string,
            description: options.description as string | undefined,
            sort_order: options.sortOrder as number | undefined,
          });
          if (ctx.out.mode === "json") {
            emitJson(result);
            return;
          }
          emitLine(ctx.out, color(ctx.out, "green", `Created wing "${result.name}"`));
        }
      )();
    });
  wing.addCommand(createCmd);

  const listCmd = new Command("list");
  listCmd
    .description("List wings")
    .option("--limit <n>", "Page size", parseInt)
    .option("--after <cursor>", "Cursor for next page")
    .option("--all", "Fetch all pages")
    .action(async (options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const pageSize = options.limit || ctx.config.defaults.page_size;
          if (options.all) {
            const items = await collectAllPages<WingResponse>(
              (req) => ctx.client.listWings(palaceId, req),
              pageSize
            );
            if (ctx.out.mode === "json") emitJson(items);
            else emit(ctx.out, items, columns(ctx));
            return;
          }
          const page = await ctx.client.listWings(palaceId, {
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(pageEnvelope(page));
          else emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  wing.addCommand(listCmd);

  const showCmd = new Command("show");
  showCmd
    .description("Show wing details")
    .argument("<id-or-name>", "Wing ID or name")
    .action(async (identifier: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const w = await resolveWing(ctx, palaceId, identifier);
          if (ctx.out.mode === "json") {
            emitJson(w);
            return;
          }
          emitLine(ctx.out, `Wing:        ${w.name}`);
          emitLine(ctx.out, `ID:          ${formatId(w.id, ctx.out)}`);
          if (w.description) emitLine(ctx.out, `Description: ${w.description}`);
          emitLine(ctx.out, `Sort order:  ${w.sort_order}`);
          emitLine(ctx.out, `Rooms:       ${w.room_count ?? "—"}`);
          emitLine(ctx.out, `Drawers:     ${w.drawer_count ?? "—"}`);
          emitLine(ctx.out, `Created:     ${formatTimestamp(w.created_at, ctx.out)}`);
        }
      )();
    });
  wing.addCommand(showCmd);

  const updateCmd = new Command("update");
  updateCmd
    .description("Update a wing")
    .argument("<id-or-name>", "Wing ID or name")
    .option("--name <name>", "New name")
    .option("--description <text>", "New description")
    .option("--sort-order <n>", "New sort order", parseInt)
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const current = await resolveWing(ctx, palaceId, identifier);
          const updated = await ctx.client.updateWing(palaceId, current.id, {
            name: options.name as string | undefined,
            description: options.description as string | undefined,
            sort_order: options.sortOrder as number | undefined,
          });
          if (ctx.out.mode === "json") emitJson(updated);
          else emitLine(ctx.out, color(ctx.out, "green", `Updated wing "${updated.name}"`));
        }
      )();
    });
  wing.addCommand(updateCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete a wing")
    .argument("<id-or-name>", "Wing ID or name")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const w = await resolveWing(ctx, palaceId, identifier);
          if (!options.force && process.stdin.isTTY) {
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete wing "${w.name}" and all its rooms/drawers?`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteWing(palaceId, w.id);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted wing "${w.name}"`));
        }
      )();
    });
  wing.addCommand(deleteCmd);

  return wing;
}

export { resolveWing };
