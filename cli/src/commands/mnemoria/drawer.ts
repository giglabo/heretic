import { Command } from "commander";
import inquirer from "inquirer";
import { readFileSync } from "node:fs";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { collectAllPages, pageEnvelope } from "./pagination";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emit, emitJson, emitLine, formatId, formatTimestamp, color } from "./output";
import type { Column } from "./output";
import { EXIT_CANCELLED, MnemoniaError, MnemoniaValidationError } from "./errors";
import type { DrawerResponse } from "./types";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function columns(ctx: MnemoniaCommandContext): Column<DrawerResponse>[] {
  return [
    { header: "ID", get: (d) => formatId(d.id, ctx.out) },
    { header: "WING", get: (d) => d.wing || "—" },
    { header: "ROOM", get: (d) => d.room || "—" },
    { header: "KEYWORD", get: (d) => d.keyword || "—" },
    {
      header: "CONTENT",
      get: (d) => {
        const first = d.content.split("\n")[0];
        return first.length > 60 ? first.substring(0, 57) + "..." : first;
      },
    },
    { header: "CREATED", get: (d) => formatTimestamp(d.created_at, ctx.out) },
  ];
}

/** heretic-cli mnemoria store [content] */
export function createStoreCommand(): Command {
  const cmd = new Command("store");
  cmd
    .description("Store a memory (drawer)")
    .argument("[content]", "Content string, or '-' to read from stdin")
    .option("-w, --wing <name>", "Target wing")
    .option("-r, --room <name>", "Target room")
    .option("-k, --keyword <word>", "Assign keyword")
    .option("-t, --tags <csv>", "Comma-separated tags")
    .option("-l, --language <code>", "Content language")
    .option("-F, --file <path>", "Read content from file")
    .action(async (content: string | undefined, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });

          let body: string;
          if (options.file) {
            body = readFileSync(options.file as string, "utf-8");
          } else if (content === "-" || (!content && !process.stdin.isTTY)) {
            body = await readStdin();
          } else if (content) {
            body = content;
          } else if (process.stdin.isTTY) {
            // Guided store
            const answers = await inquirer.prompt<{
              wing?: string;
              room?: string;
              keyword?: string;
              tags?: string;
            }>([
              {
                type: "input",
                name: "wing",
                message: "Wing (empty for default):",
                default: (options.wing as string) || ctx.config.defaults.wing,
              },
              {
                type: "input",
                name: "room",
                message: "Room (empty for default):",
                default: (options.room as string) || ctx.config.defaults.room,
              },
              {
                type: "input",
                name: "keyword",
                message: "Keyword (optional):",
                default: options.keyword,
              },
              {
                type: "input",
                name: "tags",
                message: "Tags (comma-separated, optional):",
                default: options.tags,
              },
            ]);
            options.wing = answers.wing;
            options.room = answers.room;
            options.keyword = answers.keyword;
            options.tags = answers.tags;
            emitLine(ctx.out, "");
            emitLine(ctx.out, "Enter content (Ctrl+D to finish):");
            body = await readStdin();
          } else {
            throw new MnemoniaValidationError(
              "No content provided. Pass content as an argument, via --file, or via stdin."
            );
          }

          body = body.trim();
          if (!body) {
            throw new MnemoniaValidationError("Content is empty");
          }

          const tags = options.tags
            ? (options.tags as string)
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined;

          const drawer = await ctx.client.createDrawer(palaceId, {
            content: body,
            wing: (options.wing as string) || ctx.config.defaults.wing || undefined,
            room: (options.room as string) || ctx.config.defaults.room || undefined,
            keyword: options.keyword as string | undefined,
            tags,
            language: (options.language as string) || ctx.config.defaults.language,
          });

          if (ctx.out.mode === "json") {
            emitJson(drawer);
            return;
          }
          const loc = [drawer.wing, drawer.room].filter(Boolean).join("/") || "(root)";
          emitLine(
            ctx.out,
            color(ctx.out, "green", `Stored drawer ${formatId(drawer.id, ctx.out)} in ${loc}`)
          );
          if (drawer.keyword) emitLine(ctx.out, `Keyword: ${drawer.keyword}`);
        }
      )();
    });
  return cmd;
}

export function createGetCommand(): Command {
  const cmd = new Command("get");
  cmd
    .description("Get drawer by ID")
    .argument("<id>", "Drawer ID (full UUID or short prefix)")
    .action(async (id: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const drawer = await ctx.client.getDrawer(palaceId, id);
          if (ctx.out.mode === "json") {
            emitJson(drawer);
            return;
          }
          emitLine(ctx.out, `ID:       ${formatId(drawer.id, ctx.out)}`);
          if (drawer.wing) emitLine(ctx.out, `Wing:     ${drawer.wing}`);
          if (drawer.room) emitLine(ctx.out, `Room:     ${drawer.room}`);
          if (drawer.keyword) emitLine(ctx.out, `Keyword:  ${drawer.keyword}`);
          if (drawer.language) emitLine(ctx.out, `Language: ${drawer.language}`);
          emitLine(
            ctx.out,
            `Created:  ${drawer.created_at} (${formatTimestamp(drawer.created_at, ctx.out)})`
          );
          if (drawer.tags?.length) emitLine(ctx.out, `Tags:     ${drawer.tags.join(", ")}`);
          emitLine(ctx.out, "");
          emitLine(ctx.out, "Content:");
          for (const line of drawer.content.split("\n")) {
            emitLine(ctx.out, `  ${line}`);
          }
        }
      )();
    });
  return cmd;
}

export function createListDrawersCommand(): Command {
  const cmd = new Command("list");
  cmd
    .description("List drawers")
    .option("-w, --wing <name>", "Filter by wing")
    .option("-r, --room <name>", "Filter by room")
    .option("-n, --limit <n>", "Page size", parseInt)
    .option("--after <cursor>", "Cursor for next page")
    .option("-a, --all", "Fetch all pages")
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
            const items = await collectAllPages<DrawerResponse>(
              (req) =>
                ctx.client.listDrawers(palaceId, {
                  wing: options.wing as string | undefined,
                  room: options.room as string | undefined,
                  ...req,
                }),
              pageSize
            );
            if (ctx.out.mode === "json") emitJson(items);
            else emit(ctx.out, items, columns(ctx));
            return;
          }
          const page = await ctx.client.listDrawers(palaceId, {
            wing: options.wing as string | undefined,
            room: options.room as string | undefined,
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(pageEnvelope(page));
          else emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  return cmd;
}

export function createDeleteDrawerCommand(): Command {
  const cmd = new Command("delete");
  cmd
    .description("Delete drawer by ID")
    .argument("<id>", "Drawer ID")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (id: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          if (!options.force && process.stdin.isTTY) {
            const drawer = await ctx.client.getDrawer(palaceId, id);
            const preview =
              drawer.content.substring(0, 60).replace(/\n/g, " ") +
              (drawer.content.length > 60 ? "..." : "");
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete drawer ${formatId(drawer.id, ctx.out)}? Content: "${preview}"`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteDrawer(palaceId, id);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted drawer ${formatId(id, ctx.out)}`));
        }
      )();
    });
  return cmd;
}
