import { Command } from "commander";
import inquirer from "inquirer";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractGlobalFlags, runCommand } from "./context";
import { resolvePalaceIdOrThrow } from "./palace-resolver";
import { emitJson, emitLine, color } from "./output";
import { EXIT_CANCELLED, MnemoniaError, MnemoniaValidationError } from "./errors";

/**
 * Best-effort MIME type detection for the small set of types we care about.
 * We do not add a new dependency for this — the server ultimately validates.
 */
function guessContentType(filename: string): string {
  const lower = filename.toLowerCase();
  const map: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".ts": "application/typescript",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".csv": "text/csv",
  };
  for (const ext of Object.keys(map)) {
    if (lower.endsWith(ext)) return map[ext];
  }
  return "application/octet-stream";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function createFileCommand(): Command {
  const file = new Command("file");
  file.description("Upload, download, and delete files via presigned URLs");

  const uploadCmd = new Command("upload");
  uploadCmd
    .description("Upload a file")
    .argument("<path>", "Local file path")
    .option("--keyword <word>", "Assign keyword to the uploaded file")
    .option("--content-type <mime>", "Override auto-detected MIME type")
    .action(async (path: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const absolute = resolve(path);
          if (!existsSync(absolute)) {
            throw new MnemoniaValidationError(`File not found: ${absolute}`);
          }
          const stat = statSync(absolute);
          if (!stat.isFile()) {
            throw new MnemoniaValidationError(`Not a regular file: ${absolute}`);
          }
          const filename = basename(absolute);
          const contentType = (options.contentType as string) || guessContentType(filename);

          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });

          const presigned = await ctx.client.presignUpload(palaceId, {
            filename,
            content_type: contentType,
            size: stat.size,
            keyword: options.keyword as string | undefined,
          });

          const bytes = readFileSync(absolute);
          await ctx.client.uploadToPresigned(
            presigned.upload_url,
            new Uint8Array(bytes),
            contentType,
            presigned.headers
          );

          if (ctx.out.mode === "json") {
            emitJson({
              key: presigned.key,
              size: stat.size,
              filename,
              keyword: options.keyword || null,
            });
            return;
          }
          emitLine(
            ctx.out,
            color(ctx.out, "green", `Uploaded "${filename}" (${formatBytes(stat.size)})`)
          );
          emitLine(ctx.out, `Key: ${presigned.key}`);
          if (options.keyword) emitLine(ctx.out, `Keyword: ${options.keyword as string}`);
        }
      )();
    });
  file.addCommand(uploadCmd);

  const downloadCmd = new Command("download");
  downloadCmd
    .description("Download a file by keyword or storage key")
    .argument("<keyword-or-key>", "Keyword or storage key")
    .option("-o, --output <path>", "Output directory or file path", ".")
    .action(async (target: string, options, command: Command) => {
      await runCommand(
        () => extractGlobalFlags(command.optsWithGlobals()),
        async (ctx) => {
          const palaceId = await resolvePalaceIdOrThrow(ctx.client, {
            cliPalace: ctx.flags.palace,
            defaultPalace: ctx.config.defaults.palace,
          });
          const isKey = target.includes("/");
          const presigned = await ctx.client.presignDownload(palaceId, {
            key: isKey ? target : undefined,
            keyword: isKey ? undefined : target,
          });
          const bytes = await ctx.client.downloadFromPresigned(presigned.download_url);

          const outputPath = options.output as string;
          let destination: string;
          if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
            destination = join(outputPath, presigned.filename);
          } else {
            destination = outputPath;
          }
          writeFileSync(destination, bytes);

          if (ctx.out.mode === "json") {
            emitJson({
              key: presigned.key,
              filename: presigned.filename,
              destination,
              size: presigned.size,
            });
            return;
          }
          emitLine(
            ctx.out,
            color(
              ctx.out,
              "green",
              `Downloaded "${presigned.filename}" → ${destination} (${formatBytes(presigned.size)})`
            )
          );
        }
      )();
    });
  file.addCommand(downloadCmd);

  const deleteCmd = new Command("delete");
  deleteCmd
    .description("Delete a file")
    .argument("<keyword-or-key>", "Keyword or storage key")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (target: string, options, command: Command) => {
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
                message: `Delete file "${target}"?`,
                default: false,
              },
            ]);
            if (!answer.confirm) {
              throw new MnemoniaError("Cancelled by user", undefined, undefined, EXIT_CANCELLED);
            }
          }
          await ctx.client.deleteFile(palaceId, target);
          emitLine(ctx.out, color(ctx.out, "green", `Deleted file "${target}"`));
        }
      )();
    });
  file.addCommand(deleteCmd);

  return file;
}
