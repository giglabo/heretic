import { Command } from "commander";
import inquirer from "inquirer";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { collectAllPages, pageEnvelope } from "./pagination";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emit, emitJson, emitLine, color } from "./output";
import type { Column } from "./output";
import { EXIT_CANCELLED, MnemoniaError } from "./errors";
import type { TripleResponse } from "./types";

function columns(_ctx: MnemoniaCommandContext): Column<TripleResponse>[] {
  return [
    { header: "SUBJECT", get: (t) => t.subject },
    { header: "PREDICATE", get: (t) => t.predicate },
    { header: "OBJECT", get: (t) => t.object },
    {
      header: "CONFIDENCE",
      get: (t) => t.confidence.toFixed(2),
      align: "right",
    },
    { header: "VALID FROM", get: (t) => t.valid_from || "—" },
    { header: "VALID UNTIL", get: (t) => t.valid_until || "—" },
  ];
}

export function createTripleCommand(): Command {
  const triple = new Command("triple");
  triple.description("Manage knowledge graph triples (subject-predicate-object)");

  const addCmd = new Command("add");
  addCmd
    .description("Add a triple")
    .argument("<subject>", "Subject entity name")
    .argument("<predicate>", "Relationship type")
    .argument("<object>", "Object entity name")
    .option("--confidence <f>", "Confidence score (0.0-1.0)", parseFloat)
    .option("--valid-from <date>", "Temporal validity start (ISO date)")
    .option("--valid-until <date>", "Temporal validity end (ISO date)")
    .action(
      async (subject: string, predicate: string, object: string, options, command: Command) => {
        await runCommand(
          () => extractGlobalFlags(command.optsWithGlobals()),
          async (ctx) => {
            const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
              cliPalace: ctx.flags.palace,
              defaultPalace: ctx.config.defaults.palace,
            });
            const result = await ctx.client.createTriple(palaceId, {
              subject,
              predicate,
              object,
              confidence: options.confidence !== undefined ? (options.confidence as number) : 1.0,
              valid_from: options.validFrom as string | undefined,
              valid_until: options.validUntil as string | undefined,
            });
            if (ctx.out.mode === "json") emitJson(result);
            else
              emitLine(
                ctx.out,
                color(
                  ctx.out,
                  "green",
                  `Added triple: ${result.subject} ──${result.predicate}──▶ ${result.object}`
                )
              );
          }
        )();
      }
    );
  triple.addCommand(addCmd);

  const listCmd = new Command("list");
  listCmd
    .description("List triples")
    .option("--subject <name>", "Filter by subject entity")
    .option("--predicate <rel>", "Filter by predicate")
    .option("--object <name>", "Filter by object entity")
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
            const items = await collectAllPages<TripleResponse>(
              (req) =>
                ctx.client.listTriples(palaceId, {
                  subject: options.subject as string | undefined,
                  predicate: options.predicate as string | undefined,
                  object: options.object as string | undefined,
                  ...req,
                }),
              pageSize
            );
            if (ctx.out.mode === "json") emitJson(items);
            else emit(ctx.out, items, columns(ctx));
            return;
          }
          const page = await ctx.client.listTriples(palaceId, {
            subject: options.subject as string | undefined,
            predicate: options.predicate as string | undefined,
            object: options.object as string | undefined,
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(pageEnvelope(page));
          else emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  triple.addCommand(listCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete a triple by ID")
    .argument("<id>", "Triple ID")
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
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete triple ${id.substring(0, 8)}?`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteTriple(palaceId, id);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted triple ${id.substring(0, 8)}`));
        }
      )();
    });
  triple.addCommand(deleteCmd);

  return triple;
}
