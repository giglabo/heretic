import { Command } from "commander";
import inquirer from "inquirer";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { collectAllPages, pageEnvelope } from "./pagination";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { resolveWing } from "./wing";
import { emit, emitJson, emitLine, formatId, formatTimestamp, color } from "./output";
import type { Column } from "./output";
import {
  EXIT_CANCELLED,
  MnemoniaAmbiguousError,
  MnemoniaConfigError,
  MnemoniaError,
  MnemoniaNotFoundError,
} from "./errors";
import type { RoomResponse } from "./types";

async function resolveRoom(
  ctx: MnemoniaCommandContext,
  palaceId: string,
  wingId: string,
  identifier: string
): Promise<RoomResponse> {
  const uuidLike = /^[0-9a-f-]{36}$/i.test(identifier);
  if (uuidLike) return ctx.client.getRoom(palaceId, wingId, identifier);

  const rooms = await collectAllPages<RoomResponse>(
    (req) => ctx.client.listRooms(palaceId, wingId, req),
    100
  );
  const lower = identifier.toLowerCase();
  const exact = rooms.filter((r) => r.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new MnemoniaAmbiguousError(
      "room",
      identifier,
      exact.map((r) => r.name)
    );
  }
  throw new MnemoniaNotFoundError("Room", identifier);
}

function columns(ctx: MnemoniaCommandContext): Column<RoomResponse>[] {
  return [
    { header: "ID", get: (r) => formatId(r.id, ctx.out) },
    { header: "NAME", get: (r) => r.name },
    { header: "DRAWERS", get: (r) => String(r.drawer_count ?? "—"), align: "right" },
    { header: "SORT", get: (r) => String(r.sort_order ?? 0), align: "right" },
    { header: "CREATED", get: (r) => formatTimestamp(r.created_at, ctx.out) },
  ];
}

async function resolveWingId(
  ctx: MnemoniaCommandContext,
  palaceId: string,
  wingFlag: string | undefined
): Promise<string> {
  const wingArg = wingFlag || ctx.config.defaults.wing;
  if (!wingArg) {
    throw new MnemoniaConfigError(
      "No wing specified and no default wing configured",
      "Use --wing <name> or set: heretic-cli mnemoria config set defaults.wing <name>"
    );
  }
  const wing = await resolveWing(ctx, palaceId, wingArg);
  return wing.id;
}

export function createRoomCommand(): Command {
  const room = new Command("room");
  room.description("Manage rooms");

  const createCmd = new Command("create");
  createCmd
    .description("Create a room")
    .option("-w, --wing <name>", "Parent wing (defaults to config defaults.wing)")
    .requiredOption("--name <name>", "Room name")
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
          const wingId = await resolveWingId(ctx, palaceId, options.wing as string | undefined);
          const result = await ctx.client.createRoom(palaceId, wingId, {
            name: options.name as string,
            description: options.description as string | undefined,
            sort_order: options.sortOrder as number | undefined,
          });
          if (ctx.out.mode === "json") emitJson(result);
          else emitLine(ctx.out, color(ctx.out, "green", `Created room "${result.name}"`));
        }
      )();
    });
  room.addCommand(createCmd);

  const listCmd = new Command("list");
  listCmd
    .description("List rooms")
    .option("-w, --wing <name>", "Parent wing")
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
          const wingId = await resolveWingId(ctx, palaceId, options.wing as string | undefined);
          const pageSize = options.limit || ctx.config.defaults.page_size;
          if (options.all) {
            const items = await collectAllPages<RoomResponse>(
              (req) => ctx.client.listRooms(palaceId, wingId, req),
              pageSize
            );
            if (ctx.out.mode === "json") emitJson(items);
            else emit(ctx.out, items, columns(ctx));
            return;
          }
          const page = await ctx.client.listRooms(palaceId, wingId, {
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(pageEnvelope(page));
          else emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  room.addCommand(listCmd);

  const showCmd = new Command("show");
  showCmd
    .description("Show room details")
    .argument("<id-or-name>", "Room ID or name")
    .option("-w, --wing <name>", "Parent wing")
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const wingId = await resolveWingId(ctx, palaceId, options.wing as string | undefined);
          const r = await resolveRoom(ctx, palaceId, wingId, identifier);
          if (ctx.out.mode === "json") emitJson(r);
          else {
            emitLine(ctx.out, `Room:        ${r.name}`);
            emitLine(ctx.out, `ID:          ${formatId(r.id, ctx.out)}`);
            if (r.description) emitLine(ctx.out, `Description: ${r.description}`);
            emitLine(ctx.out, `Drawers:     ${r.drawer_count ?? "—"}`);
            emitLine(ctx.out, `Created:     ${formatTimestamp(r.created_at, ctx.out)}`);
          }
        }
      )();
    });
  room.addCommand(showCmd);

  const updateCmd = new Command("update");
  updateCmd
    .description("Update a room")
    .argument("<id-or-name>", "Room ID or name")
    .option("-w, --wing <name>", "Parent wing")
    .option("--name <name>", "New name")
    .option("--description <text>", "New description")
    .option("--sort-order <n>", "Sort order", parseInt)
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const wingId = await resolveWingId(ctx, palaceId, options.wing as string | undefined);
          const current = await resolveRoom(ctx, palaceId, wingId, identifier);
          const updated = await ctx.client.updateRoom(palaceId, wingId, current.id, {
            name: options.name as string | undefined,
            description: options.description as string | undefined,
            sort_order: options.sortOrder as number | undefined,
          });
          if (ctx.out.mode === "json") emitJson(updated);
          else emitLine(ctx.out, color(ctx.out, "green", `Updated room "${updated.name}"`));
        }
      )();
    });
  room.addCommand(updateCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete a room")
    .argument("<id-or-name>", "Room ID or name")
    .option("-w, --wing <name>", "Parent wing")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const wingId = await resolveWingId(ctx, palaceId, options.wing as string | undefined);
          const r = await resolveRoom(ctx, palaceId, wingId, identifier);
          if (!options.force && process.stdin.isTTY) {
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete room "${r.name}"?`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteRoom(palaceId, wingId, r.id);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted room "${r.name}"`));
        }
      )();
    });
  room.addCommand(deleteCmd);

  return room;
}
