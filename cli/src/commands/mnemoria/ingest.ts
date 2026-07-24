import { Command } from "commander";
import { resolve } from "node:path";
import { extractGlobalFlags, runCommand } from "./context";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emit, emitJson, emitLine, formatId, formatTimestamp, color } from "./output";
import type { Column, OutputContext } from "./output";
import type { IngestJobResponse, IngestSource } from "./types";

export function createIngestCommand(): Command {
  const ingest = new Command("ingest");
  ingest.description("Ingest files into a palace");

  // heretic-cli mnemoria ingest <path>
  ingest
    .argument("[path]", "Directory or file to ingest")
    .option("--source <type>", "Source type: filesystem | conversation", "filesystem")
    .option("-w, --wing <name>", "Target wing")
    .option("-r, --room <name>", "Target room")
    .option("-l, --language <code>", "Content language")
    .option("--include <glob>", "Include pattern (repeatable)", collectArg, [] as string[])
    .option("--exclude <glob>", "Exclude pattern (repeatable)", collectArg, [] as string[])
    .option("--chunk-size <n>", "Target chunk size in tokens", parseInt)
    .option("--min-chunk-size <n>", "Minimum chunk size", parseInt)
    .option("--chunk-overlap <n>", "Overlap between chunks", parseInt)
    .option("--extract-entities", "Extract entities and triples from content", false)
    .option("--watch", "Watch for file changes and re-ingest", false)
    .option("--dry-run", "Show what would be ingested without writing", false)
    .option("--no-progress", "Disable progress display")
    .action(async (path: string | undefined, options, command: Command) => {
      // If no path is provided, show help for the ingest group so the user
      // discovers the `status` subcommand.
      if (!path) {
        command.help();
        return;
      }
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });

          const job = await ctx.client.startIngest(palaceId, {
            source: options.source as IngestSource,
            path: resolve(path),
            wing: (options.wing as string) || ctx.config.defaults.wing || undefined,
            room: (options.room as string) || ctx.config.defaults.room || undefined,
            language: (options.language as string) || ctx.config.defaults.language,
            include: (options.include as string[]).length
              ? (options.include as string[])
              : undefined,
            exclude: (options.exclude as string[]).length
              ? (options.exclude as string[])
              : undefined,
            chunk_size: options.chunkSize as number | undefined,
            min_chunk_size: options.minChunkSize as number | undefined,
            chunk_overlap: options.chunkOverlap as number | undefined,
            extract_entities: Boolean(options.extractEntities),
            watch: Boolean(options.watch),
            dry_run: Boolean(options.dryRun),
          });

          if (options.dryRun || job.status === "completed") {
            if (ctx.out.mode === "json") emitJson(job);
            else printJobSummary(ctx.out, job);
            return;
          }

          if (ctx.out.mode === "json") {
            // JSON mode: just return the initial job object
            emitJson(job);
            return;
          }

          const useProgress = process.stdout.isTTY && !options.noProgress;
          let current = job;
          const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
          let frame = 0;

          while (current.status !== "completed" && current.status !== "failed") {
            await sleep(1000);
            try {
              current = await ctx.client.getIngestStatus(palaceId, current.job_id);
            } catch {
              break;
            }
            if (useProgress) {
              const total = current.files_total || 0;
              const done = current.files_processed;
              const pct = total > 0 ? ` (${Math.round((done / total) * 100)}%)` : "";
              process.stdout.write(
                `\r${spinner[frame % spinner.length]} Ingesting... ${done}${
                  total ? `/${total}` : ""
                }${pct}  chunks: ${current.chunks_created}  entities: ${current.entities_found}  `
              );
              frame++;
            }
          }
          if (useProgress) process.stdout.write("\n");
          printJobSummary(ctx.out, current);
        }
      )();
    });

  const statusCmd = new Command("status");
  statusCmd
    .description("Check ingest job status")
    .argument("[job-id]", "Job ID")
    .option("--recent", "List recent ingest jobs")
    .action(async (jobId: string | undefined, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          if (options.recent) {
            const page = await ctx.client.listIngestJobs(palaceId, 10);
            if (ctx.out.mode === "json") {
              emitJson(page.items);
              return;
            }
            const cols: Column<IngestJobResponse>[] = [
              { header: "JOB", get: (j) => formatId(j.job_id, ctx.out) },
              { header: "STATUS", get: (j) => j.status },
              {
                header: "FILES",
                get: (j) =>
                  j.files_total
                    ? `${j.files_processed}/${j.files_total}`
                    : String(j.files_processed),
                align: "right",
              },
              { header: "CHUNKS", get: (j) => String(j.chunks_created), align: "right" },
              {
                header: "STARTED",
                get: (j) => formatTimestamp(j.started_at, ctx.out),
              },
            ];
            emit(ctx.out, page.items, cols);
            return;
          }
          if (!jobId) {
            command.help();
            return;
          }
          const job = await ctx.client.getIngestStatus(palaceId, jobId);
          if (ctx.out.mode === "json") emitJson(job);
          else printJobSummary(ctx.out, job);
        }
      )();
    });
  ingest.addCommand(statusCmd);

  return ingest;
}

function printJobSummary(ctx: OutputContext, job: IngestJobResponse): void {
  emitLine(ctx, "");
  const status =
    job.status === "completed"
      ? color(ctx, "green", "Ingestion complete.")
      : job.status === "failed"
        ? color(ctx, "red", `Ingestion failed: ${job.error || "unknown"}`)
        : `Ingestion ${job.status}.`;
  emitLine(ctx, status);
  emitLine(ctx, "");
  const rows = [
    { k: "Files processed", v: String(job.files_processed) },
    { k: "Files total", v: String(job.files_total ?? "—") },
    { k: "Chunks created", v: String(job.chunks_created) },
    { k: "Entities found", v: String(job.entities_found) },
    { k: "Triples created", v: String(job.triples_created) },
    { k: "Job ID", v: job.job_id },
  ];
  for (const row of rows) {
    emitLine(ctx, `${row.k.padEnd(16)} ${row.v}`);
  }
}

function collectArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
