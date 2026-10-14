---
name: heretic-mnemoria-spaces
description: Complete reference for the mnemoria spatial hierarchy commands — `palace create/list/show/update/delete`, `wing create/list/show/update/delete`, `room create/list/show/update/delete` — including every flag, name-vs-UUID resolution and ambiguity rules, the wing/room default requirements, table columns, JSON shapes, confirmation prompts, cascade-delete semantics, and the underlying REST endpoints. Use when organizing a Mnemoria memory palace, creating/renaming/deleting palaces, wings or rooms, or debugging "No palace specified", "Ambiguous wing name", or missing-default-wing errors.
---

> **Branch-only feature.** The whole `mnemoria` group lives in the `feat/mnemoria` branch
> (commit `441cea2`, `cli/src/commands/mnemoria/`) and is **not on `main`**. Treat this
> documentation as an archive of that branch.

# Mnemoria spatial hierarchy: palace → wing → room

```
palace                 tenant-scoped memory store; owns embeddings, drawers, entities, keywords
 └── wing              top-level section (sort_order)
      └── room         subsection of a wing (sort_order)
           └── drawer  the actual memory (see heretic-mnemoria-memory)
```

Read `heretic-mnemoria` first for global flags, auth, output modes and exit codes.
Sources: `cli/src/commands/mnemoria/{palace,palace-resolver,wing,room}.ts`.

## Identifier resolution (the rule that explains most errors)

**Palace** (`resolvePalace`): a value matching the UUID regex is fetched directly; otherwise
**all** palaces are listed (page size 100, hard cap 5 000) and matched case-insensitively —
exact name first, then unique **prefix**. Multiple matches →
`Ambiguous palace name "eng". Matches: engineering, engine-lab` +
`Use the full name or ID to disambiguate.` No match →
`Palace "x" not found` + `Run 'heretic-cli mnemoria palace list' to see available palaces.`

**Which palace do commands use?** `resolvePalaceIdOrThrow`: `-P/--palace` flag, else
`defaults.palace` (which already includes `MN_DEFAULT_PALACE`). Neither →
`No palace specified and no default palace configured` +
`Use -P <palace> flag or set a default: heretic-cli mnemoria config use-palace <name>`.

**Wing** (`resolveWing`) and **Room** (`resolveRoom`): a 36-char `[0-9a-f-]` string is fetched
directly; otherwise the full list is paged (100/page) and matched by **exact**
case-insensitive name only — **no prefix matching**. Ambiguity → `Ambiguous wing name …`;
no match → `Wing "x" not found` / `Room "x" not found`.

Rooms live under a wing, so every room command needs one: `-w/--wing`, else
`defaults.wing`. Neither → `No wing specified and no default wing configured` +
`Use --wing <name> or set: heretic-cli mnemoria config set defaults.wing <name>`.

## `palace`

```
mn palace create --name <name> [--language <code>] [--description <text>]
                 [--additional-languages <csv>] [--embedding-dimensions <n>] [--set-default]
mn palace list   [--limit <n>] [--after <cursor>] [--all]
mn palace show   <id-or-name>
mn palace update <id-or-name> [--name] [--description] [--language] [--additional-languages]
mn palace delete <id-or-name> [-f|--force]
```

- `--name` is **required**. `--language` defaults to `defaults.language` (`en`).
- `--additional-languages` is comma-separated; entries are trimmed and empties dropped.
- `--embedding-dimensions` is parsed with `parseInt`; omit it to let the server choose.
  It is fixed at creation — `update` cannot change it.
- `--set-default` writes `defaults.palace = <name>` into `config.yaml` after creation.

```
$ mn palace create --name engineering --language en --additional-languages de,fr --set-default
Created palace "engineering" (a1b2c3d4)
Language: en (+de, fr)
Embedding dimensions: 1536
Default palace set to "engineering"
```

`palace list` columns: `ID`, `NAME`, `LANGUAGE` (with `(+extras)`), `DRAWERS`, `ENTITIES`
(right-aligned; `—` when the server omits counts), `CREATED`. With a next page and table
output it appends `(more results: --after <cursor>)`.

`palace show` prints a detail block (name, ID, language, dimensions, created as
`<iso> (<relative>)`, description) plus a counts table: Drawers / Entities / Triples /
Keywords.

`palace update` sends only the flags you pass (others are `undefined`, i.e. untouched).
There is no way to *clear* a description — send an empty string if the server accepts it.

`palace delete` prompts unless `-f`, **and only when stdin is a TTY** (non-TTY invocations
delete immediately — important for scripts and CI):

```
? Delete palace "engineering" and ALL its data? This cannot be undone. (y/N)
```

Declining exits **130**. The server cascades: wings, rooms, drawers, entities, triples,
keywords and files of that palace go with it. Deleting the palace that `defaults.palace`
points at leaves a dangling default — fix it with `config use-palace`.

## `wing`

```
mn wing create --name <name> [--description <text>] [--sort-order <n>]
mn wing list   [--limit <n>] [--after <cursor>] [--all]
mn wing show   <id-or-name>
mn wing update <id-or-name> [--name] [--description] [--sort-order <n>]
mn wing delete <id-or-name> [-f|--force]
```

`--name` required on create. Columns: `ID`, `NAME`, `ROOMS`, `DRAWERS`, `SORT`, `CREATED`.
`wing show` prints name, ID, description, sort order, room count, drawer count, created.
`wing delete` prompts (TTY only, default No): `Delete wing "x" and all its rooms/drawers?`
— cascade includes rooms and their drawers.

`sort_order` is display metadata only; nothing in the CLI sorts by it.

## `room`

```
mn room create [-w|--wing <name>] --name <name> [--description <text>] [--sort-order <n>]
mn room list   [-w|--wing <name>] [--limit <n>] [--after <cursor>] [--all]
mn room show   <id-or-name> [-w|--wing <name>]
mn room update <id-or-name> [-w|--wing <name>] [--name] [--description] [--sort-order <n>]
mn room delete <id-or-name> [-w|--wing <name>] [-f|--force]
```

Every subcommand resolves the wing first (flag → `defaults.wing` → error). Columns: `ID`,
`NAME`, `DRAWERS`, `SORT`, `CREATED`. Delete prompt: `Delete room "x"?` (TTY only, default No).

There is **no `room move`** — a room cannot be reparented to another wing; recreate it and
re-file the drawers.

## REST endpoints (for debugging with curl)

| Command | Method + path |
| --- | --- |
| palace create/list | `POST` / `GET /api/v1/palaces` |
| palace show/update/delete | `GET`/`PUT`/`DELETE /api/v1/palaces/{id}` |
| wing create/list | `POST`/`GET /api/v1/palaces/{pid}/wings` |
| wing show/update/delete | `GET`/`PUT`/`DELETE /api/v1/palaces/{pid}/wings/{id}` |
| room create/list | `POST`/`GET /api/v1/palaces/{pid}/wings/{wid}/rooms` |
| room show/update/delete | `GET`/`PUT`/`DELETE /api/v1/palaces/{pid}/wings/{wid}/rooms/{id}` |

All paths URL-encode their segments; list endpoints accept `limit`, `after` (palaces also
`before`).

## JSON shapes

```jsonc
// PalaceResponse
{ "id": "…", "name": "engineering", "language": "en", "description": "…",
  "additional_languages": ["de"], "embedding_dimensions": 1536,
  "drawer_count": 120, "entity_count": 42, "triple_count": 88, "keyword_count": 17,
  "created_at": "2026-…", "updated_at": "2026-…" }

// WingResponse
{ "id": "…", "palace_id": "…", "name": "backend", "description": "…", "sort_order": 0,
  "room_count": 3, "drawer_count": 55, "created_at": "…", "updated_at": "…" }

// RoomResponse
{ "id": "…", "palace_id": "…", "wing_id": "…", "name": "api", "description": "…",
  "sort_order": 0, "drawer_count": 12, "created_at": "…", "updated_at": "…" }
```

`--all` returns a flat array; a single page in `-j` mode returns the pagination envelope.

## Worked example

```bash
mn palace create --name engineering --set-default
mn config set defaults.wing backend

mn wing create --name backend --description "Server-side code and decisions" --sort-order 0
mn wing create --name frontend --sort-order 1
mn wing list

mn room create --name api --description "HTTP surface"          # uses defaults.wing
mn room create -w frontend --name components
mn room list -w frontend

mn store "The /v1/users endpoint is deprecated; use /v2/users." -w backend -r api
mn -j palace show engineering | jq '{drawers: .drawer_count, entities: .entity_count}'
```

## Gotchas

- Wing/room names resolve by **exact match only** — `mn room show ap` fails even if `api` is
  the only room. Palaces additionally allow a unique prefix.
- Name resolution costs a full list traversal each time; in scripts prefer UUIDs (`--ids full`
  to capture them, or `-j`).
- Confirmation prompts are skipped when stdin is not a TTY, so scripted deletes are
  irreversible without warning. Always pass `-f` deliberately.
- Counts (`drawer_count`, `room_count`, …) are server-provided; `—` means the server did not
  send them, not zero.
- `defaults.wing`/`defaults.room` also feed `store`, `list` and `ingest`, so setting them
  changes behavior across the whole group.
- Two palaces may share a name; the resolver then refuses to guess (`Ambiguous palace name`).
- `mn palace list --all` caps at 10 000 items (5 000 during name resolution).
