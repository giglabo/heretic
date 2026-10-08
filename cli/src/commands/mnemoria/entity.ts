import { Command } from "commander";
import inquirer from "inquirer";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { resolvePalaceIdOrThrow, isUuid } from "./palace-resolver";
import { collectAllPages, pageEnvelope } from "./pagination";
import { emit, emitJson, emitLine, formatId, formatTimestamp, color } from "./output";
import type { Column } from "./output";
import {
  EXIT_CANCELLED,
  MnemoniaAmbiguousError,
  MnemoniaError,
  MnemoniaNotFoundError,
} from "./errors";
import type { EntityResponse } from "./types";

async function resolveEntity(
  ctx: MnemoniaCommandContext,
  palaceId: string,
  identifier: string
): Promise<EntityResponse> {
  if (isUuid(identifier)) return ctx.client.getEntity(palaceId, identifier);
  const entities = await collectAllPages<EntityResponse>(
    (req) => ctx.client.listEntities(palaceId, req),
    100
  );
  const lower = identifier.toLowerCase();
  const exact = entities.filter((e) => e.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new MnemoniaAmbiguousError(
      "entity",
      identifier,
      exact.map((e) => e.name)
    );
  }
  throw new MnemoniaNotFoundError("Entity", identifier);
}

function columns(ctx: MnemoniaCommandContext): Column<EntityResponse>[] {
  return [
    { header: "NAME", get: (e) => e.name },
    { header: "TYPE", get: (e) => e.entity_type },
    { header: "TRIPLES", get: (e) => String(e.triple_count ?? "—"), align: "right" },
    {
      header: "DESCRIPTION",
      get: (e) => {
        if (!e.description) return "";
        return e.description.length > 60 ? e.description.substring(0, 57) + "..." : e.description;
      },
    },
    { header: "CREATED", get: (e) => formatTimestamp(e.created_at, ctx.out) },
  ];
}

export function createEntityCommand(): Command {
  const entity = new Command("entity");
  entity.description("Manage knowledge graph entities");

  const addCmd = new Command("add");
  addCmd
    .description("Add or update an entity")
    .argument("<name>", "Entity name")
    .requiredOption("--type <type>", "Entity type (Person, Technology, Concept, ...)")
    .option("--description <text>", "Entity description")
    .action(async (name: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const result = await ctx.client.createEntity(palaceId, {
            name,
            entity_type: options.type as string,
            description: options.description as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(result);
          else emitLine(ctx.out, color(ctx.out, "green", `Added entity "${result.name}"`));
        }
      )();
    });
  entity.addCommand(addCmd);

  const listCmd = new Command("list");
  listCmd
    .description("List entities")
    .option("--type <type>", "Filter by entity type")
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
            const items = await collectAllPages<EntityResponse>(
              (req) =>
                ctx.client.listEntities(palaceId, {
                  entity_type: options.type as string | undefined,
                  ...req,
                }),
              pageSize
            );
            if (ctx.out.mode === "json") emitJson(items);
            else emit(ctx.out, items, columns(ctx));
            return;
          }
          const page = await ctx.client.listEntities(palaceId, {
            entity_type: options.type as string | undefined,
            limit: pageSize,
            after: options.after as string | undefined,
          });
          if (ctx.out.mode === "json") emitJson(pageEnvelope(page));
          else emit(ctx.out, page.items, columns(ctx));
        }
      )();
    });
  entity.addCommand(listCmd);

  const showCmd = new Command("show");
  showCmd
    .description("Show entity details and relationships")
    .argument("<name-or-id>", "Entity name or ID")
    .action(async (identifier: string, _opts, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const e = await resolveEntity(ctx, palaceId, identifier);
          const triples = await ctx.client.getEntityTriples(palaceId, e.id);
          if (ctx.out.mode === "json") {
            emitJson({ entity: e, triples: triples.items });
            return;
          }
          emitLine(ctx.out, `Entity:      ${e.name}`);
          emitLine(ctx.out, `ID:          ${formatId(e.id, ctx.out)}`);
          emitLine(ctx.out, `Type:        ${e.entity_type}`);
          if (e.description) emitLine(ctx.out, `Description: ${e.description}`);
          emitLine(ctx.out, `Triples:     ${triples.items.length}`);
          emitLine(
            ctx.out,
            `Created:     ${e.created_at} (${formatTimestamp(e.created_at, ctx.out)})`
          );
          if (triples.items.length > 0) {
            emitLine(ctx.out, "");
            emitLine(ctx.out, "Relationships:");
            for (const t of triples.items) {
              const validity = t.valid_from
                ? ` valid ${t.valid_from} → ${t.valid_until || "∞"}`
                : "";
              emitLine(
                ctx.out,
                `  ${t.subject} ──${t.predicate}──▶ ${t.object} (${t.confidence.toFixed(2)})${validity}`
              );
            }
          }
        }
      )();
    });
  entity.addCommand(showCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete an entity")
    .argument("<name-or-id>", "Entity name or ID")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (identifier: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const e = await resolveEntity(ctx, palaceId, identifier);
          if (!options.force && process.stdin.isTTY) {
            const answer = await inquirer.prompt<{ confirm: boolean }>([
              {
                type: "confirm",
                name: "confirm",
                message: `Delete entity "${e.name}" and all its triples?`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteEntity(palaceId, e.id);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted entity "${e.name}"`));
        }
      )();
    });
  entity.addCommand(deleteCmd);

  return entity;
}

export { resolveEntity };
