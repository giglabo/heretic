import { Command } from "commander";
import { extractGlobalFlags, runCommand, type MnemoniaCommandContext } from "./context";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emit, emitJson, emitLine, formatId, color } from "./output";
import type { Column } from "./output";
import { MnemoniaValidationError } from "./errors";
import type { SearchResultItem } from "./types";

function columns(
  ctx: MnemoniaCommandContext,
  showScore: boolean
): Column<SearchResultItem & { _idx: number }>[] {
  const cols: Column<SearchResultItem & { _idx: number }>[] = [
    { header: "#", get: (r) => String(r._idx), align: "right" },
  ];
  if (showScore) {
    cols.push({
      header: "SCORE",
      get: (r) => r.score.toFixed(2),
      align: "right",
    });
  }
  cols.push(
    { header: "TYPE", get: (r) => r.type },
    { header: "WING", get: (r) => r.wing || "—" },
    { header: "ROOM", get: (r) => r.room || "—" },
    {
      header: "CONTENT",
      get: (r) => {
        const first = r.content.split("\n")[0];
        return first.length > 60 ? first.substring(0, 57) + "..." : first;
      },
    }
  );
  cols.push({ header: "ID", get: (r) => formatId(r.id, ctx.out) });
  return cols;
}

export function createSearchCommand(): Command {
  const cmd = new Command("search");
  cmd
    .description("Combined semantic + keyword + knowledge-graph search")
    .argument("[query]", "Semantic search text")
    .option("-k, --keyword <pattern>", "Keyword search pattern (%_ wildcards)")
    .option("-e, --entity <name>", "Filter by KG entity name")
    .option("--entity-type <type>", "Filter entity by type")
    .option("-w, --wing <name>", "Scope to wing")
    .option("-r, --room <name>", "Scope to room")
    .option("-n, --limit <n>", "Max results", (v) => parseInt(v, 10), 10)
    .option("-c, --content-only", "Output only content text separated by ---")
    .option("--score", "Show relevance scores in table output")
    .action(async (query: string | undefined, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          if (!query && !options.keyword && !options.entity) {
            throw new MnemoniaValidationError(
              "Search requires at least one of: query, --keyword, --entity"
            );
          }
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const response = await ctx.client.search(palaceId, {
            query,
            keyword: options.keyword as string | undefined,
            entity: options.entity as string | undefined,
            entity_type: options.entityType as string | undefined,
            wing: options.wing as string | undefined,
            room: options.room as string | undefined,
            limit: options.limit as number,
          });

          if (options.contentOnly) {
            const blocks = response.items.map((i) => i.content).join("\n---\n");
            emitLine(ctx.out, blocks);
            return;
          }

          if (ctx.out.mode === "json") {
            emitJson({
              items: response.items,
              mode_counts: response.mode_counts || {},
              total: response.total,
            });
            return;
          }

          const rowsWithIdx = response.items.map((item, idx) => ({ ...item, _idx: idx + 1 }));
          const header = response.mode_counts
            ? `Found ${response.total} results (${Object.entries(response.mode_counts)
                .map(([m, n]) => `${m}: ${n}`)
                .join(", ")})`
            : `Found ${response.total} results`;
          emitLine(ctx.out, color(ctx.out, "dim", header));
          emitLine(ctx.out, "");
          emit(ctx.out, rowsWithIdx, columns(ctx, Boolean(options.score)));
        }
      )();
    });
  return cmd;
}
