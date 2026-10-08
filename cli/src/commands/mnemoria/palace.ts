import { Command } from "commander";
import inquirer from "inquirer";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { collectAllPages, pageEnvelope } from "./pagination";
import { resolvePalace } from "./palace-resolver";
import { emit, emitJson, emitLine, formatId, formatTimestamp, color } from "./output";
import type { Column } from "./output";
import { EXIT_CANCELLED, MnemoniaError } from "./errors";
import type { PalaceResponse } from "./types";

function columns(ctx: MnemoniaCommandContext): Column<PalaceResponse>[] {
  return [
    { header: "ID", get: (p) => formatId(p.id, ctx.out) },
    { header: "NAME", get: (p) => p.name },
    {
      header: "LANGUAGE",
      get: (p) => {
        const extras = p.additional_languages?.length
          ? ` (+${p.additional_languages.join(", ")})`
          : "";
        return `${p.language}${extras}`;
      },
    },
    { header: "DRAWERS", get: (p) => String(p.drawer_count ?? "—"), align: "right" },
    { header: "ENTITIES", get: (p) => String(p.entity_count ?? "—"), align: "right" },
    { header: "CREATED", get: (p) => formatTimestamp(p.created_at, ctx.out) },
  ];
}

export function createPalaceCommand(): Command {
  const palace = new Command("palace");
  palace.description("Manage palaces");

  const createCmd = new Command("create");
  createCmd
    .description("Create a new palace")
    .requiredOption("--name <name>", "Palace name")
    .option("--language <code>", "Primary language")
    .option("--description <text>", "Description")
    .option("--additional-languages <codes>", "Comma-separated additional languages")
    .option("--embedding-dimensions <n>", "Embedding vector dimensions", parseInt)
    .option("--set-default", "Set as default palace after creation", false)
    .action(async (options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const additional = options.additionalLanguages
            ? (options.additionalLanguages as string)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          const result = await ctx.client.createPalace({
            name: options.name as string,
            language: (options.language as string) || ctx.config.defaults.language,
            description: options.description as string | undefined,
            additional_languages: additional,
            embedding_dimensions: options.embeddingDimensions as number | undefined,
          });
          if (ctx.out.mode === "json") {
            emitJson(result);
            return;
          }
          emitLine(
            ctx.out,
            color(
              ctx.out,
              "green",
              `Created palace "${result.name}" (${formatId(result.id, ctx.out)})`
            )
          );
          if (additional?.length) {
            emitLine(ctx.out, `Language: ${result.language} (+${additional.join(", ")})`);
          }
          emitLine(ctx.out, `Embedding dimensions: ${result.embedding_dimensions}`);

          if (options.setDefault) {
            const { loadMnemoniaConfigFile, saveMnemoniaConfigFile, setConfigField } =
              await import("./config-loader");
            const cfg = loadMnemoniaConfigFile();
            saveMnemoniaConfigFile(setConfigField(cfg, "defaults.palace", result.name));
            emitLine(ctx.out, `Default palace set to "${result.name}"`);
          }
        }
      )();
    });
  palace.addCommand(createCmd);

  const listCmd = new Command("list");
  listCmd
    .description("List palaces")
    .option("--limit <n>", "Page size", parseInt)
    .option("--after <cursor>", "Cursor for next page")
    .option("--all", "Fetch all pages")
    .action(async (options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const pageSize = options.limit || ctx.config.defaults.page_size;
          if (options.all) {
            const items = await collectAllPages<PalaceResponse>(
              (req) => ctx.client.listPalaces(req),
              pageSize
            );
            if (ctx.out.mode === "json") {
              emitJson(items);
            } else {
              emit(ctx.out, items, columns(ctx));
            }
            return;
          }
          const page = await ctx.client.listPalaces({
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") {
            emitJson(pageEnvelope(page));
            return;
          }
          emit(ctx.out, page.items, columns(ctx));
          if (page.has_next) {
            emitLine(
              ctx.out,
              color(ctx.out, "dim", `\n(more results: --after ${page.next_cursor})`)
            );
          }
        }
      )();
    });
  palace.addCommand(listCmd);

  const showCmd = new Command("show");
  showCmd
    .description("Show palace details")
    .argument("<id-or-name>", "Palace ID or name")
    .action(async (identifier: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const p = await resolvePalace(ctx.client, identifier);
          if (ctx.out.mode === "json") {
            emitJson(p);
            return;
          }
          emitLine(ctx.out, `Palace:      ${p.name}`);
          emitLine(ctx.out, `ID:          ${formatId(p.id, ctx.out)}`);
          emitLine(
            ctx.out,
            `Language:    ${p.language}${
              p.additional_languages?.length ? ` (+${p.additional_languages.join(", ")})` : ""
            }`
          );
          emitLine(ctx.out, `Dimensions:  ${p.embedding_dimensions}`);
          emitLine(
            ctx.out,
            `Created:     ${p.created_at} (${formatTimestamp(p.created_at, ctx.out)})`
          );
          if (p.description) emitLine(ctx.out, `Description: ${p.description}`);
          emitLine(ctx.out, "");
          const stats: Array<{ k: string; v: string }> = [
            { k: "Drawers", v: String(p.drawer_count ?? "—") },
            { k: "Entities", v: String(p.entity_count ?? "—") },
            { k: "Triples", v: String(p.triple_count ?? "—") },
            { k: "Keywords", v: String(p.keyword_count ?? "—") },
          ];
          const cols: Column<(typeof stats)[number]>[] = [
            { header: "", get: (r) => r.k },
            { header: "COUNT", get: (r) => r.v, align: "right" },
          ];
          emit(ctx.out, stats, cols);
        }
      )();
    });
  palace.addCommand(showCmd);

  const updateCmd = new Command("update");
  updateCmd
    .description("Update a palace")
    .argument("<id-or-name>", "Palace ID or name")
    .option("--name <name>", "New name")
    .option("--description <text>", "New description")
    .option("--language <code>", "New primary language")
    .option("--additional-languages <codes>", "Comma-separated additional languages")
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const current = await resolvePalace(ctx.client, identifier);
          const additional = options.additionalLanguages
            ? (options.additionalLanguages as string)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          const updated = await ctx.client.updatePalace(current.id, {
            name: options.name as string | undefined,
            description: options.description as string | undefined,
            language: options.language as string | undefined,
            additional_languages: additional,
          });
          if (ctx.out.mode === "json") {
            emitJson(updated);
            return;
          }
          emitLine(ctx.out, color(ctx.out, "green", `Updated palace "${updated.name}"`));
        }
      )();
    });
  palace.addCommand(updateCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete a palace")
    .argument("<id-or-name>", "Palace ID or name")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const p = await resolvePalace(ctx.client, identifier);
          if (!options.force && process.stdin.isTTY) {
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete palace "${p.name}" and ALL its data? This cannot be undone.`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deletePalace(p.id);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted palace "${p.name}"`));
        }
      )();
    });
  palace.addCommand(deleteCmd);

  return palace;
}
