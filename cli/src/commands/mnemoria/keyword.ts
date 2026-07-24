import { Command } from "commander";
import inquirer from "inquirer";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { collectAllPages, pageEnvelope } from "./pagination";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emit, emitJson, emitLine, formatTimestamp, color } from "./output";
import type { Column } from "./output";
import { EXIT_CANCELLED, MnemoniaError, MnemoniaValidationError } from "./errors";
import type { KeywordResponse, KeywordTtlPreset } from "./types";

function columns(ctx: MnemoniaCommandContext): Column<KeywordResponse>[] {
  return [
    { header: "WORD", get: (k) => k.assigned_word || k.word },
    { header: "STATUS", get: (k) => k.status },
    { header: "TARGET", get: (k) => k.target_type },
    { header: "TTL", get: (k) => k.ttl },
    { header: "EXPIRES", get: (k) => k.expires_at || "—" },
    { header: "CREATED", get: (k) => formatTimestamp(k.created_at, ctx.out) },
  ];
}

function asTtl(v: unknown): KeywordTtlPreset | undefined {
  if (typeof v !== "string") return undefined;
  const allowed: KeywordTtlPreset[] = ["ephemeral", "sprint", "quarter", "year", "permanent"];
  return allowed.includes(v as KeywordTtlPreset) ? (v as KeywordTtlPreset) : undefined;
}

export function createKeywordCommand(): Command {
  const keyword = new Command("keyword");
  keyword.description("Manage human-readable keywords");

  const assignCmd = new Command("assign");
  assignCmd
    .description("Assign a keyword to content, a drawer, an entity, or a file")
    .argument("<word>", "The keyword to assign")
    .argument("[content]", "Text content (creates a Text target)")
    .option("--drawer <id>", "Point keyword to existing drawer")
    .option("--entity <name>", "Point keyword to existing entity")
    .option("--file <key>", "Point keyword to existing file")
    .option("-w, --wing <name>", "Wing scope")
    .option("-r, --room <name>", "Room scope")
    .option(
      "--ttl <preset>",
      "TTL preset: ephemeral (24h), sprint (2w), quarter (90d), year, permanent"
    )
    .action(async (word: string, content: string | undefined, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });

          const targets = [
            options.drawer ? "drawer" : null,
            options.entity ? "entity" : null,
            options.file ? "file" : null,
            content ? "content" : null,
          ].filter(Boolean);
          if (targets.length === 0) {
            throw new MnemoniaValidationError(
              "Must specify one of: content argument, --drawer, --entity, --file"
            );
          }
          if (targets.length > 1) {
            throw new MnemoniaValidationError(
              `Cannot specify multiple targets (${targets.join(", ")})`
            );
          }

          let targetType: "Text" | "Drawer" | "Entity" | "File";
          if (options.drawer) targetType = "Drawer";
          else if (options.entity) targetType = "Entity";
          else if (options.file) targetType = "File";
          else targetType = "Text";

          const result = await ctx.client.assignKeyword(palaceId, {
            word,
            target_type: targetType,
            content,
            drawer_id: options.drawer as string | undefined,
            entity_id: options.entity as string | undefined,
            file_key: options.file as string | undefined,
            wing: (options.wing as string) || undefined,
            room: (options.room as string) || undefined,
            ttl: asTtl(options.ttl) || "permanent",
          });

          if (ctx.out.mode === "json") {
            emitJson(result);
            return;
          }
          if (result.assigned_word && result.assigned_word !== result.word) {
            emitLine(
              ctx.out,
              color(
                ctx.out,
                "yellow",
                `Keyword "${result.word}" already existed. Assigned as "${result.assigned_word}" instead.`
              )
            );
          } else {
            emitLine(
              ctx.out,
              color(
                ctx.out,
                "green",
                `Assigned keyword "${result.assigned_word || result.word}" → ${result.target_type}`
              )
            );
          }
        }
      )();
    });
  keyword.addCommand(assignCmd);

  const getCmd = new Command("get");
  getCmd
    .description("Resolve a keyword to its target content")
    .argument("<word>", "Keyword to resolve")
    .action(async (word: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const k = await ctx.client.resolveKeyword(palaceId, word);
          if (ctx.out.mode === "json") {
            emitJson(k);
            return;
          }
          emitLine(ctx.out, `Keyword:  ${k.assigned_word || k.word}`);
          emitLine(ctx.out, `Status:   ${k.status}`);
          emitLine(ctx.out, `Target:   ${k.target_type}`);
          emitLine(ctx.out, `TTL:      ${k.ttl}`);
          if (k.expires_at) emitLine(ctx.out, `Expires:  ${k.expires_at}`);
          if (k.wing) emitLine(ctx.out, `Wing:     ${k.wing}`);
          if (k.room) emitLine(ctx.out, `Room:     ${k.room}`);
          emitLine(
            ctx.out,
            `Created:  ${k.created_at} (${formatTimestamp(k.created_at, ctx.out)})`
          );
          if (k.content) {
            emitLine(ctx.out, "");
            emitLine(ctx.out, "Content:");
            for (const line of k.content.split("\n")) {
              emitLine(ctx.out, `  ${line}`);
            }
          }
        }
      )();
    });
  keyword.addCommand(getCmd);

  const searchCmd = new Command("search");
  searchCmd
    .description("Search keywords by pattern (% and _ wildcards)")
    .argument("<pattern>", "Keyword pattern")
    .option("--limit <n>", "Max results", parseInt)
    .action(async (pattern: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const page = await ctx.client.searchKeywords(
            palaceId,
            pattern,
            options.limit as number | undefined
          );
          if (ctx.out.mode === "json") {
            emitJson(pageEnvelope(page));
            return;
          }
          emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  keyword.addCommand(searchCmd);

  const listCmd = new Command("list");
  listCmd
    .description("List all keywords")
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
            const items = await collectAllPages<KeywordResponse>(
              (req) => ctx.client.listKeywords(palaceId, req),
              pageSize
            );
            if (ctx.out.mode === "json") emitJson(items);
            else emit(ctx.out, items, columns(ctx));
            return;
          }
          const page = await ctx.client.listKeywords(palaceId, {
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(pageEnvelope(page));
          else emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  keyword.addCommand(listCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Soft-delete a keyword")
    .argument("<word>", "Keyword to delete")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (word: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          if (!options.force && process.stdin.isTTY) {
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete keyword "${word}"?`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteKeyword(palaceId, word);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted keyword "${word}"`));
        }
      )();
    });
  keyword.addCommand(deleteCmd);

  return keyword;
}
