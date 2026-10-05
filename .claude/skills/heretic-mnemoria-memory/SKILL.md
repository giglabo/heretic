---
name: heretic-mnemoria-memory
description: Complete reference for mnemoria memory operations — `store`, `get`, `list`, `delete` (drawers), `search` (semantic + keyword + graph), `keyword assign/get/search/list/delete` with TTL presets, `file upload/download/delete` via presigned URLs, and `ingest`/`ingest status` with chunking and entity extraction. Covers stdin/file/guided input, content-only output, wildcard patterns, MIME detection, progress polling, JSON shapes and REST endpoints. Use when storing or retrieving memories, searching a palace, managing keywords or files, or running/monitoring ingestion.
---

> **Branch-only feature.** The whole `mnemoria` group lives in the `feat/mnemoria` branch
> (commit `441cea2`, `cli/src/commands/mnemoria/`) and is **not on `main`**. Treat this
> documentation as an archive of that branch.

# Mnemoria memory operations: drawers, search, keywords, files, ingest

Read `heretic-mnemoria` first (global flags, palace defaults, output modes, exit codes) and
`heretic-mnemoria-spaces` for wing/room placement. Sources:
`cli/src/commands/mnemoria/{drawer,search,keyword,file,ingest}.ts`.

Every command here resolves the palace via `-P/--palace` → `defaults.palace` and fails with
`No palace specified and no default palace configured` otherwise.

## `store` — write a drawer

```
mn store [content] [-w wing] [-r room] [-k keyword] [-t tags-csv] [-l language] [-F file]
```

Content is taken from the **first** available source:

1. `-F, --file <path>` — file contents (read as UTF-8; a missing file throws a raw ENOENT).
2. `content == "-"`, or no `content` **and stdin is not a TTY** — read all of stdin.
3. `content` argument.
4. Interactive **guided store** (TTY, no content): prompts for wing / room / keyword / tags
   (pre-filled from flags and `defaults.wing`/`defaults.room`), then
   `Enter content (Ctrl+D to finish):` and reads stdin.
5. Otherwise → `No content provided. Pass content as an argument, via --file, or via stdin.`

Content is trimmed; empty → `Content is empty`. `--tags` is split on commas and trimmed.
Wing/room fall back to `defaults.wing`/`defaults.room`; language to `defaults.language`.

```bash
mn store "Postgres connection pool is capped at 20 in prod." -w backend -r db -t "ops,postgres"
git log -1 --stat | mn store - -w backend -r history
mn store -F ./decisions/2026-08-adr-014.md -w architecture -k adr-014
mn store            # guided (TTY)
```

Output: `Stored drawer a1b2c3d4 in backend/db` (`(root)` when neither wing nor room), plus
`Keyword: <word>` when one was assigned. `-j` prints the whole `DrawerResponse`.

## `get` — read one drawer

```
mn get <id>          # full UUID or short prefix (server-side resolution)
```

Prints ID, wing, room, keyword, language, `Created: <iso> (<relative>)`, tags, then
`Content:` with every line indented two spaces. `-j` prints the raw object.

## `list` — page through drawers

```
mn list [-w wing] [-r room] [-n|--limit <n>] [--after <cursor>] [-a|--all]
```

Columns: `ID`, `WING`, `ROOM`, `KEYWORD`, `CONTENT` (first line, truncated to 57 chars +
`...`), `CREATED`. `--all` walks every page (flat array in JSON mode); a single page in JSON
mode is the pagination envelope. Note `list` uses `-n` for limit (not `--limit`) and `-a` for
all — different letters than the `palace`/`wing`/`room` groups.

## `delete` — remove a drawer

```
mn delete <id> [-f|--force]
```

Without `-f` **and** with a TTY it first fetches the drawer and prompts with a 60-char
preview: `Delete drawer a1b2c3d4? Content: "…"` (default **No**; declining exits **130**).
Non-TTY runs delete immediately.

## `search` — hybrid retrieval

```
mn search [query] [-k pattern] [-e entity] [--entity-type type]
          [-w wing] [-r room] [-n limit=10] [-c|--content-only] [--score]
```

At least one of `query`, `-k`, `-e` is required, else
`Search requires at least one of: query, --keyword, --entity`. The server decides how to
blend modes (`semantic`, `keyword`, `graph`, `hybrid`) and returns per-mode counts.

- `-k/--keyword` takes SQL-LIKE wildcards: `%` = any sequence, `_` = one char.
- `-e/--entity` filters by knowledge-graph entity name; `--entity-type` narrows the type.
- `-c/--content-only` prints just the contents joined by `\n---\n` — ideal for piping into a
  prompt. It bypasses JSON mode entirely.
- `--score` adds a right-aligned `SCORE` column (2 decimals) in table output.

```
$ mn search "connection pool" --score
Found 3 results (semantic: 2, keyword: 1)

#  SCORE  TYPE      WING     ROOM  CONTENT                                    ID
1   0.87  semantic  backend  db    Postgres connection pool is capped at 20…  a1b2c3d4
```

```bash
mn search -k "adr-%" -n 50                     # keyword pattern
mn search -e "PostgreSQL" --entity-type Technology
mn search "retry policy" -w backend -c         # content only, for a prompt
mn -j search "retry policy" | jq '.items[].id'
```

JSON: `{ items: SearchResultItem[], mode_counts: {…}, total: n }` where each item is
`{id, type, score, content, wing, room, keyword, created_at, metadata}`.

## `keyword` — human-readable handles

```
mn keyword assign <word> [content] [--drawer <id>|--entity <name>|--file <key>]
                         [-w wing] [-r room] [--ttl <preset>]
mn keyword get    <word>
mn keyword search <pattern> [--limit <n>]
mn keyword list   [--limit <n>] [--after <cursor>] [--all]
mn keyword delete <word> [-f|--force]
```

Exactly **one** target: the `content` argument (→ `Text`), `--drawer` (→ `Drawer`),
`--entity` (→ `Entity`), or `--file` (→ `File`). Zero →
`Must specify one of: content argument, --drawer, --entity, --file`; more than one →
`Cannot specify multiple targets (drawer, content)`.

TTL presets (`--ttl`, default **`permanent`**; an unrecognized value silently falls back to
`permanent`): `ephemeral` (24h), `sprint` (2w), `quarter` (90d), `year`, `permanent`.

Collision handling is server-side: if the word is taken, the server assigns a suffixed word
and the CLI reports it in yellow —
`Keyword "cache" already existed. Assigned as "cache2" instead.` **Always use the returned
`assigned_word`.**

`keyword get` prints word, status (`active`/`expired`/`deleted`), target type, TTL, expiry,
wing, room, created, then the content when the target is text.
`keyword search` accepts `%`/`_` wildcards. Columns for list/search: `WORD`, `STATUS`,
`TARGET`, `TTL`, `EXPIRES`, `CREATED`.
`keyword delete` is a **soft delete** (status → `deleted`), prompts on TTY unless `-f`.

```bash
mn keyword assign adr-014 -w architecture --ttl permanent "Use event sourcing for billing"
mn keyword assign sprint-notes --drawer a1b2c3d4 --ttl sprint
mn keyword get adr-014
mn keyword search "adr-%"
mn keyword list --all -j | jq -r '.[] | [.assigned_word,.target_type,.ttl] | @tsv'
```

## `file` — presigned upload/download

```
mn file upload   <path> [--keyword <word>] [--content-type <mime>]
mn file download <keyword-or-key> [-o|--output <path>]
mn file delete   <keyword-or-key> [-f|--force]
```

**Upload**: resolves the path, requires a regular file
(`File not found: …` / `Not a regular file: …`), guesses the MIME type from the extension
(txt, md, json, yaml/yml, html/htm, css, js, ts, pdf, png, jpg/jpeg, gif, svg, webp, mp4,
webm, mp3, wav, zip, tar, gz, csv → else `application/octet-stream`; override with
`--content-type`), asks the server for a presigned PUT (`filename`, `content_type`, `size`,
optional `keyword`), then PUTs the bytes with any `headers` the server returned.

```
$ mn file upload ./architecture.pdf --keyword arch-diagram
Uploaded "architecture.pdf" (2.4 MB)
Key: palaces/…/architecture.pdf
Keyword: arch-diagram
```

**Download**: the argument is treated as a **storage key when it contains `/`**, otherwise as
a keyword. `-o` may be a directory (the server-provided filename is appended) or a file path;
default `.`. Prints `Downloaded "<name>" → <dest> (<size>)`.

**Delete**: prompts on TTY unless `-f`; the argument is passed through as the key.

The whole file is buffered in memory on both paths (`readFileSync` / `arrayBuffer`), and the
transfer shares `server.timeout` (default 30 s) — raise it for large files:
`mn config set server.timeout 300000`. There is no `file list` command; use
`mn keyword list` (target type `File`) or `mn search`.

## `ingest` — bulk import

```
mn ingest <path> [--source filesystem|conversation] [-w wing] [-r room] [-l language]
                 [--include <glob>]… [--exclude <glob>]…
                 [--chunk-size <n>] [--min-chunk-size <n>] [--chunk-overlap <n>]
                 [--extract-entities] [--watch] [--dry-run] [--no-progress]
mn ingest status [job-id] [--recent]
```

`<path>` is resolved to an absolute path **on the machine running the CLI** and sent to the
server — the *server* must be able to read it (same host, or a shared mount). Without a path
the group prints its help (so you discover `status`).

`--include`/`--exclude` are repeatable globs. Chunking knobs are token counts interpreted
server-side. `--extract-entities` also builds entities/triples (see
`heretic-mnemoria-graph`). `--watch` asks the server to keep re-ingesting on change.
`--dry-run` reports what would happen and returns immediately.

Progress: in table mode on a TTY (unless `--no-progress`) the CLI polls
`GET …/ingest/<job_id>` every second and renders a braille spinner with
`files_processed/files_total (pct)`, chunks and entities, then prints a summary:

```
Ingestion complete.

Files processed  128
Files total      128
Chunks created   1043
Entities found   87
Triples created  56
Job ID           7f3c…
```

In `-j` mode **no polling happens** — the initial job object is emitted and you poll
yourself. A failed poll breaks the loop silently and prints the last known state.
`ingest status --recent` lists the 10 most recent jobs (`JOB`, `STATUS`, `FILES`, `CHUNKS`,
`STARTED`).

```bash
mn ingest ./docs --include "**/*.md" --exclude "**/node_modules/**" -w docs --extract-entities
mn ingest ./docs --dry-run
mn -j ingest ./docs | jq -r .job_id
mn ingest status 7f3c… ; mn ingest status --recent
```

Job statuses: `pending`, `running`, `completed`, `failed`, `cancelled`. There is **no
`ingest cancel`** command — stop it server-side.

## REST endpoints

| Command | Method + path |
| --- | --- |
| store / list | `POST` / `GET /api/v1/palaces/{pid}/drawers` (`wing`, `room`, `limit`, `after`) |
| get / delete | `GET` / `DELETE /api/v1/palaces/{pid}/drawers/{id}` |
| search | `POST /api/v1/palaces/{pid}/search` |
| keyword assign / list | `POST` / `GET /api/v1/palaces/{pid}/keywords` |
| keyword get / delete | `GET` / `DELETE /api/v1/palaces/{pid}/keywords/{word}` |
| keyword search | `POST /api/v1/palaces/{pid}/keywords/search` `{pattern, limit}` |
| file upload / download | `POST /api/v1/palaces/{pid}/files/upload` / `…/files/download` |
| file delete | `DELETE /api/v1/palaces/{pid}/files/{key}` |
| ingest start / list | `POST` / `GET /api/v1/palaces/{pid}/ingest` |
| ingest status | `GET /api/v1/palaces/{pid}/ingest/{jobId}` |

## Gotchas

- **No drawer update.** Drawers are immutable through the CLI — store a new one and delete
  the old.
- `store` with **no arguments in a pipeline** reads stdin (non-TTY detection), which is what
  makes `cmd | mn store` work; interactively it becomes the guided flow instead.
- `-n` (limit) and `-a` (all) on `mn list` vs `--limit`/`--all` elsewhere: easy to mix up.
- `search -c` ignores `-j`; `search` has no `--all` (use `-n`).
- Keyword collisions rename silently-but-visibly — parse `assigned_word` in scripts.
- `keyword delete` is soft; the word may still appear with status `deleted`.
- `file download` guesses key-vs-keyword by the presence of `/` — a keyword containing a
  slash is unreachable.
- Confirmation prompts only exist on a TTY; scripted `delete` never asks.
- `ingest` paths are server-side paths; a local relative path that resolves on your laptop
  means nothing to a remote server.
- Large files/ingests can hit `server.timeout` → `MnemoniaTimeoutError` (exit 3).
