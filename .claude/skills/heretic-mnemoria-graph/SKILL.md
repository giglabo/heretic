---
name: heretic-mnemoria-graph
description: Complete reference for the mnemoria knowledge-graph commands — `entity add/list/show/delete`, `triple add/list/delete` with confidence and temporal validity, and `graph path/timeline/neighborhood` traversal. Covers entity types, name-vs-UUID resolution, the arrow rendering format, filters, JSON shapes, REST endpoints and limitations (no update, no cycle/subgraph export). Use when building or querying a Mnemoria knowledge graph, adding relationships, tracing paths between entities, or inspecting an entity's neighborhood/timeline.
---

> **Branch-only feature.** The whole `mnemoria` group lives in the `feat/mnemoria` branch
> (commit `441cea2`, `cli/src/commands/mnemoria/`) and is **not on `main`** — `cli.ts` on
> `main` has no mnemoria registration. Treat this documentation as an archive of that branch.

# Mnemoria knowledge graph: entities, triples, traversal

The graph is a per-palace store of **entities** (nodes) and **triples**
(subject —predicate→ object edges) with a confidence score and optional temporal validity.
Read `heretic-mnemoria` first for global flags/auth/output. Sources:
`cli/src/commands/mnemoria/{entity,triple,graph}.ts`.

All commands resolve the palace via `-P/--palace` → `defaults.palace`.

## `entity`

```
mn entity add    <name> --type <type> [--description <text>]
mn entity list   [--type <type>] [--limit <n>] [--after <cursor>] [--all]
mn entity show   <name-or-id>
mn entity delete <name-or-id> [-f|--force]
```

`--type` is **required** on `add`. The declared type union is `Person | Organization |
Project | Technology | Concept | Location | Event | File | Module | Function | Other`, but the
CLI passes the string through unvalidated — the **server** decides what it accepts, so a
custom type may work or may come back as a 400 validation error.

`add` is upsert-ish by intent ("Add or update an entity"): it POSTs the entity, and the
server decides whether a same-named entity is created or updated. Output:
`Added entity "PostgreSQL"`.

`entity list` columns: `NAME`, `TYPE`, `TRIPLES` (right-aligned), `DESCRIPTION` (truncated to
57 chars + `...`), `CREATED`. Note there is **no ID column** — get IDs from `-j` or
`entity show`.

`entity show` resolves the entity (UUID → direct fetch; otherwise the full entity list is
paged at 100/page and matched by **exact** case-insensitive name; several matches →
`Ambiguous entity name "x". Matches: …`; none → `Entity "x" not found`), then fetches its
triples and renders them:

```
Entity:      PostgreSQL
ID:          a1b2c3d4
Type:        Technology
Description: Primary datastore
Triples:     3
Created:     2026-08-01T10:00:00Z (9d ago)

Relationships:
  billing-service ──depends_on──▶ PostgreSQL (0.95)
  PostgreSQL ──runs_on──▶ aws-rds (1.00) valid 2026-01-01 → ∞
```

`entity delete` prompts on a TTY unless `-f`:
`Delete entity "x" and all its triples?` (default **No**; declining exits **130**).
Non-TTY runs delete immediately. Deleting an entity **cascades to its triples**.

## `triple`

```
mn triple add    <subject> <predicate> <object> [--confidence <0..1>]
                 [--valid-from <iso>] [--valid-until <iso>]
mn triple list   [--subject <name>] [--predicate <rel>] [--object <name>]
                 [--limit <n>] [--after <cursor>] [--all]
mn triple delete <id> [-f|--force]
```

- All three positional arguments are required. Subject/object are **entity names as
  strings** — the CLI does not resolve or auto-create them; whether an unknown name is
  created or rejected is the server's call.
- `--confidence` is parsed with `parseFloat`, **default `1.0`**. Out-of-range values are not
  checked client-side.
- `--valid-from` / `--valid-until` are ISO dates enabling bi-temporal queries; omitting
  `--valid-until` means "still valid" (rendered as `∞`).
- Predicates are free-form strings (`depends_on`, `owns`, `deprecated_by`, …). Pick a
  convention and stick to it — nothing normalizes them.

```
$ mn triple add billing-service depends_on PostgreSQL --confidence 0.95 --valid-from 2026-01-01
Added triple: billing-service ──depends_on──▶ PostgreSQL
```

`triple list` columns: `SUBJECT`, `PREDICATE`, `OBJECT`, `CONFIDENCE` (2 decimals,
right-aligned), `VALID FROM`, `VALID UNTIL`. Filters combine (server-side AND).
Again **no ID column** — `triple delete` needs an ID, so fetch it with `-j`:

```bash
mn -j triple list --subject billing-service | jq -r '.items[] | [.id,.predicate,.object] | @tsv'
mn triple delete 7f3c1b2a-… -f
```

`triple delete` prompts `Delete triple 7f3c1b2a?` on a TTY unless `-f` (default No; 130 on
decline). Deletion is by **ID only** — you cannot delete by subject/predicate/object triple.

## `graph`

```
mn graph path         <from> <to> [--max-depth <n>=10]
mn graph timeline     <entity> [--from <iso>] [--to <iso>] [--limit <n>]
mn graph neighborhood <entity> [--depth <n>=1]
```

**`path`** — server-side shortest path. Table output:

```
Path (distance: 2):
  billing-service ──depends_on──▶ PostgreSQL ──runs_on──▶ aws-rds
```

When the server returns no edges it falls back to printing the bare node list
(`a → b`). JSON: `{path: string[], edges: [{subject,predicate,object,confidence}], distance}`.
Note `path` passes the names through **unresolved** (no entity lookup), so a typo yields
whatever the server says about an unknown node.

**`timeline`** — temporal evolution of an entity's relationships:

```
Timeline for "PostgreSQL":

DATE        RELATIONSHIP
2026-01-01  billing-service ──depends_on──▶ PostgreSQL (0.95)
2026-06-14  PostgreSQL ──deprecated_by──▶ Aurora (0.70)
```

JSON: `{entity, events: [{date, subject, predicate, object, confidence}]}`.

**`neighborhood`** — incoming and outgoing edges (this one **does** resolve the entity name
first, so ambiguity/not-found errors apply):

```
Neighborhood of "PostgreSQL" (depth=1):

  ← depends_on ── billing-service (Project, 0.95)
  → runs_on ── aws-rds (Technology, 1.00)
```

`←` rows are incoming, `→` outgoing (arrows are dimmed when color is on). `--depth 2`
requests two hops; the server decides what it supports. JSON:
`{entity: EntityResponse, depth, incoming: [{entity, predicate, confidence}], outgoing: […]}`.

## JSON shapes

```jsonc
// EntityResponse
{ "id": "…", "palace_id": "…", "name": "PostgreSQL", "entity_type": "Technology",
  "description": "…", "triple_count": 3, "created_at": "…", "updated_at": "…" }

// TripleResponse
{ "id": "…", "palace_id": "…", "subject": "billing-service", "predicate": "depends_on",
  "object": "PostgreSQL", "confidence": 0.95,
  "valid_from": "2026-01-01", "valid_until": null, "metadata": {}, "created_at": "…" }
```

## REST endpoints

| Command | Method + path |
| --- | --- |
| entity add / list | `POST` / `GET /api/v1/palaces/{pid}/entities` (`entity_type`, `limit`, `after`) |
| entity show / delete | `GET` / `DELETE /api/v1/palaces/{pid}/entities/{id}` |
| entity triples (used by `show`) | `GET /api/v1/palaces/{pid}/entities/{id}/triples` |
| neighborhood | `GET /api/v1/palaces/{pid}/entities/{id}/neighborhood?depth=n` |
| triple add / list | `POST` / `GET /api/v1/palaces/{pid}/triples` (`subject`, `predicate`, `object`, `limit`, `after`) |
| triple delete | `DELETE /api/v1/palaces/{pid}/triples/{id}` |
| path | `POST /api/v1/palaces/{pid}/graph/shortest-path` `{from,to,max_depth}` |
| timeline | `GET /api/v1/palaces/{pid}/timeline/{entity}?from&to&limit` |

## Worked example

```bash
mn entity add billing-service --type Project --description "Invoicing + payments"
mn entity add PostgreSQL      --type Technology
mn entity add aws-rds         --type Technology

mn triple add billing-service depends_on PostgreSQL --confidence 0.95 --valid-from 2026-01-01
mn triple add PostgreSQL runs_on aws-rds
mn triple add PostgreSQL deprecated_by Aurora --confidence 0.7 --valid-from 2026-06-14

mn entity show PostgreSQL
mn graph neighborhood PostgreSQL --depth 2
mn graph path billing-service aws-rds
mn graph timeline PostgreSQL --from 2026-01-01

# graph-scoped retrieval of drawers
mn search -e PostgreSQL --entity-type Technology
```

Populate the graph automatically from documents with
`mn ingest ./docs --extract-entities` (see `heretic-mnemoria-memory`).

## Limitations

- **No update commands.** `entity add` re-posts (server decides); a triple's confidence or
  validity cannot be edited — delete and re-add.
- `entity list` and `triple list` show **no IDs**; use `-j` (or `--ids full` where an ID
  column exists) to get the identifiers that `triple delete` requires.
- Entity resolution is **exact-match only** (no prefix), and `graph path`/`timeline` don't
  resolve names at all.
- No subgraph export (DOT/GraphML/JSON-LD), no cycle detection, no "all paths", no
  bulk import of triples, no `graph stats`.
- Confidence is not range-checked client-side; `--max-depth`/`--depth` semantics are entirely
  server-defined.
- Deleting an entity silently removes every triple referencing it.
