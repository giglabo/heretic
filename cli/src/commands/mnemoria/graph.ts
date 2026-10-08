import { Command } from "commander";
import { extractGlobalFlags, runCommand } from "./context";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { resolveEntity } from "./entity";
import { emit, emitJson, emitLine, color } from "./output";
import type { Column } from "./output";
import type { TimelineEvent } from "./types";

export function createGraphCommand(): Command {
  const graph = new Command("graph");
  graph.description("Traverse the knowledge graph");

  const pathCmd = new Command("path");
  pathCmd
    .description("Find shortest path between two entities")
    .argument("<from>", "Starting entity name")
    .argument("<to>", "Target entity name")
    .option("--max-depth <n>", "Maximum traversal depth", parseInt, 10)
    .action(async (from: string, to: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const result = await ctx.client.shortestPath(palaceId, {
            from,
            to,
            max_depth: options.maxDepth as number,
          });
          if (ctx.out.mode === "json") {
            emitJson(result);
            return;
          }
          emitLine(ctx.out, `Path (distance: ${result.distance}):`);
          if (result.edges.length === 0) {
            emitLine(ctx.out, `  ${result.path.join(" → ")}`);
            return;
          }
          const parts: string[] = [];
          for (const edge of result.edges) {
            parts.push(edge.subject);
            parts.push(`──${edge.predicate}──▶`);
          }
          parts.push(result.edges[result.edges.length - 1].object);
          emitLine(ctx.out, `  ${parts.join(" ")}`);
        }
      )();
    });
  graph.addCommand(pathCmd);

  const timelineCmd = new Command("timeline");
  timelineCmd
    .description("Show temporal evolution of an entity's relationships")
    .argument("<entity>", "Entity name")
    .option("--from <date>", "Start date (ISO format)")
    .option("--to <date>", "End date (ISO format)")
    .option("--limit <n>", "Max results", parseInt)
    .action(async (entityName: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const result = await ctx.client.timeline(palaceId, entityName, {
            from: options.from as string | undefined,
            to: options.to as string | undefined,
            limit: options.limit as number | undefined,
          });
          if (ctx.out.mode === "json") {
            emitJson(result);
            return;
          }
          emitLine(ctx.out, `Timeline for "${result.entity}":`);
          emitLine(ctx.out, "");
          const cols: Column<TimelineEvent>[] = [
            { header: "DATE", get: (e) => e.date },
            {
              header: "RELATIONSHIP",
              get: (e) =>
                `${e.subject} ──${e.predicate}──▶ ${e.object} (${e.confidence.toFixed(2)})`,
            },
          ];
          emit(ctx.out, result.events, cols);
        }
      )();
    });
  graph.addCommand(timelineCmd);

  const neighborhoodCmd = new Command("neighborhood");
  neighborhoodCmd
    .description("Show immediate neighbors of an entity")
    .argument("<entity>", "Entity name")
    .option("--depth <n>", "Traversal depth (1 = direct, 2 = two hops)", parseInt, 1)
    .action(async (entityName: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const e = await resolveEntity(ctx, palaceId, entityName);
          const result = await ctx.client.getEntityNeighborhood(
            palaceId,
            e.id,
            options.depth as number
          );
          if (ctx.out.mode === "json") {
            emitJson(result);
            return;
          }
          emitLine(ctx.out, `Neighborhood of "${result.entity.name}" (depth=${result.depth}):`);
          emitLine(ctx.out, "");
          for (const inc of result.incoming) {
            emitLine(
              ctx.out,
              `  ${color(ctx.out, "dim", "←")} ${inc.predicate} ── ${inc.entity.name} (${inc.entity.entity_type}, ${inc.confidence.toFixed(2)})`
            );
          }
          for (const out of result.outgoing) {
            emitLine(
              ctx.out,
              `  ${color(ctx.out, "dim", "→")} ${out.predicate} ── ${out.entity.name} (${out.entity.entity_type}, ${out.confidence.toFixed(2)})`
            );
          }
        }
      )();
    });
  graph.addCommand(neighborhoodCmd);

  return graph;
}
