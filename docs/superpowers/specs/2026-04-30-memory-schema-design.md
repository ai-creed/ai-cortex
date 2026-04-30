# Memory Schema Design

**Date:** 2026-04-30
**Status:** draft
**Scope:** Memory layer for ai-cortex — schema, storage, lifecycle, retrieval, and injection.

---

## Goal

Define a practical, implementable memory model for ai-cortex: structured, persistent, evolving knowledge derived from agent sessions. Memory turns past interactions into a durable, deduplicated, transparent store that any agent harness can read and write through MCP.

This spec covers the memory schema and its supporting subsystems (auto-extractor, lifecycle, retrieval). It does not cover MCP harness configuration, deployment, or downstream agent UX beyond the tool surface.

---

## Context

ai-cortex already captures raw session transcripts under `~/.cache/ai-cortex/<repoKey>/history/` (see `src/lib/history/`). Each session is an immutable snapshot with a compacted summary and an `EvidenceLayer` (`toolCalls`, `filePaths`, `userPrompts`, `corrections`).

Sessions are evidence. They are not memory. A session ends; the insight inside it stays buried unless someone re-asks. Memory is the layer that distils evidence into durable, structured, evolving knowledge — decisions, gotchas, patterns, how-tos — with explicit lifecycle (creation, refinement, deprecation, merge, removal).

Existing assets we extend:
- `~/.cache/ai-cortex/<repoKey>/` — per-repo cache layout, atomic-write conventions
- `src/lib/history/` — session capture, compaction, evidence layer, embedding sidecar
- `src/lib/embed-provider.ts` — Xenova MiniLM L6 v2 sentence embeddings (reused; no new model)
- `src/mcp/server.ts` — MCP tool registration pattern
- `src/lib/cache-store.ts` — atomic temp-file rename, repo-key isolation

What's new:
- Memory store, parallel to `history/`, with its own sqlite index and markdown source-of-truth files
- Two-tier (project + global) layout
- Lifecycle state machine
- Auto-extractor that derives candidate memories from session evidence
- Retrieval and injection MCP tools

---

## Architecture

### Module structure

```text
src/
  lib/
    memory/
      types.ts              ← schema types (frontmatter, lifecycle states, edges)
      store.ts              ← .md file I/O (read, write, atomic rename) + dir layout
      index.ts              ← sqlite index: schema, queries, audit log, links table
      embed.ts              ← single-vector-per-memory embedding via embed-provider
      retrieve.ts           ← two-stage filter + linear ranker
      lifecycle.ts          ← state transitions, promotion signals, scope updates
      aging.ts              ← sweep policies (candidate/deprecated/merged_into/trashed → next state)
      registry.ts           ← types.json: built-in + user-extensible types
      bootstrap.ts          ← one-shot extraction over existing history sessions
    history/
      extract.ts            ← NEW: session evidence → candidate memories (rule-based heuristics)
                              uses: this session's evidence + summary; writes via memory.store
  mcp/
    server.ts               ← register memory tools
  cli.ts                    ← add: memory <subcommand>
```

Boundaries:
- `store.ts` is the only writer of `.md` files. `index.ts` is the only writer of sqlite. Both are called by `lifecycle.ts`, never directly by callers.
- `retrieve.ts` is read-only; `lifecycle.ts` is write-only.
- `extract.ts` lives under `history/` (it consumes history) but writes into memory via `record_memory` — same path as explicit writes.

### Data flow

```
explicit write:
  agent → MCP record_memory → lifecycle.create → store.write(.md) + index.upsert + embed.update

extracted write:
  hook → history.capture → history.compact → history.extract → lifecycle.create (source: extracted)

retrieval:
  agent → MCP recall_memory → retrieve.query → index.filter → embed.cosine + linear rank → top-K

auto-inject:
  agent → MCP rehydrate_project → briefing builder → memory.list(pinned: true | high-conf decisions/gotchas) → top-5

aging:
  session start (or sweep_aging) → aging.sweep → lifecycle.transition for each match
```

---

## Storage layout

### Two-tier — project and global

Same code path; two cache roots.

```
~/.cache/ai-cortex/
  global/
    memory/
      memories/                     ← active markdown files
      trash/                        ← awaiting purge (≥90d)
      index.sqlite
      .vectors.bin
      .vectors.meta.json
      types.json                    ← extensible type registry
      extractor-runs/               ← per-session extractor manifests
  <repoKey>/
    memory/                         ← same shape as global/memory
      ...
```

`global` is a reserved repoKey. Every project query merges its store with `global` via sqlite `ATTACH DATABASE`. Project memories receive a small ranker boost (more specific wins on ties).

### Source of truth vs index

- **Markdown files = canonical.** Sqlite can be deleted at any time and rebuilt via `rebuild_index()`. Every read of a memory body comes from the `.md` file, not sqlite.
- **Body hash drift detection.** Sqlite stores `body_hash`; on read, store compares against the `.md` file's actual hash; mismatch triggers re-index of that single record.
- **Atomic write.** `.md` writes use `.tmp + rename`. Sqlite uses WAL mode for concurrent reads under a writer.

### Vectors

One vector per memory, embedded from `title + body` concatenated. Stored in the existing `.vectors.bin` + `.vectors.meta.json` sidecar pattern (mirrors how `history/store.ts` stores chunk vectors). Updated inline on every body write (`update_memory`, `merge_memories`).

---

## Schema

### Common frontmatter (every memory)

```yaml
---
id: mem-2026-04-30-cache-atomic-writes      # mem-YYYY-MM-DD-<slug>; slug from title, kebab-case, ≤40 chars
type: decision                                # decision | gotcha | pattern | how-to | <user-registered>
status: active                                # active | candidate | deprecated | merged_into | trashed | stale_reference
title: Repo cache writes use atomic temp-file rename   # ≤120 chars
version: 3                                    # integer; bumped on each body/scope mutation
createdAt: 2026-04-21T14:02:11Z              # ISO-8601 UTC
updatedAt: 2026-04-30T09:18:44Z
source: explicit                              # explicit | extracted
confidence: 1.0                               # 0.0–1.0; explicit defaults 1.0; extracted varies
pinned: false                                 # auto-inject in rehydration briefing
scope:
  files: [src/lib/cache-store.ts]            # zero or more; empty = project-wide
  tags:  [caching, atomicity]                # zero or more
provenance:
  - sessionId: s-2026-04-21-7c3e             # references history session
    turn: 42                                  # turn within that session
    kind: user_correction                    # mirrors EvidenceLayer kinds in history/types.ts
    excerpt: "we got burned last quarter when..."  # optional cached text
supersedes: []                                # ids replaced by this memory (1:1 lifecycle pointer)
mergedInto: null                              # destination id if status=merged_into
deprecationReason: null                       # text if status=deprecated
promotedFrom: []                              # if global, list of source-project provenance
---
```

`provenance.kind` values (mirroring `src/lib/history/types.ts` `EvidenceLayer`):
- `user_correction` (from `corrections`)
- `user_prompt` (from `userPrompts`)
- `tool_call` (from `toolCalls`)
- `summary` (from session summary)

### Per-type fields and body conventions

Body conventions are **recommendations**, not enforcement. Memories that ignore the headings remain valid; conformant ones get better preview rendering and slightly better vector retrieval.

#### `decision`

- **Frontmatter additions:** optional `expiresOn: <ISO-date>` for time-bound decisions that should be reviewed.
- **Body sections:** `## Rule`, `## Why`, `## Alternatives considered` (optional).

#### `gotcha`

- **Frontmatter additions:** `severity: info | warning | critical` (filterable; agents prioritize critical when scope matches).
- **Body sections:** `## Symptom`, `## Cause`, `## Workaround`, `## How to detect` (optional).

#### `pattern`

- **Frontmatter additions:** none.
- **Body sections:** `## Where`, `## Convention`, `## Examples`.

#### `how-to`

- **Frontmatter additions:** none. Prerequisites are expressed via `depends_on` edges in the `memory_links` table, not in frontmatter.
- **Body sections:** `## Goal`, `## Steps` (numbered list), `## Verification`.

### Type registry — `types.json`

User-extensible. Lives at the root of each store (project and global have independent registries).

```jsonc
{
  "version": 1,
  "types": {
    "decision":  { "builtIn": true,  "bodySections": ["Rule", "Why", "Alternatives considered"] },
    "gotcha":    { "builtIn": true,  "extraFrontmatter": { "severity": ["info","warning","critical"] }, "bodySections": ["Symptom","Cause","Workaround","How to detect"] },
    "pattern":   { "builtIn": true,  "bodySections": ["Where","Convention","Examples"] },
    "how-to":    { "builtIn": true,  "bodySections": ["Goal","Steps","Verification"] },

    "incident": {
      "builtIn": false,
      "extraFrontmatter": { "severity": ["minor","major","outage"], "rootCauseLink": "string?" },
      "bodySections": ["Trigger","Impact","Root cause","Resolution","Prevention"]
    }
  }
}
```

Validation enforces only what the registry says — frontmatter field presence, enum values for typed fields. User-defined types coexist with built-ins.

### Sqlite schema (the index)

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL,
  title         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  source        TEXT NOT NULL,
  confidence    REAL NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  body_hash     TEXT NOT NULL,            -- detect drift between .md and index
  body_excerpt  TEXT NOT NULL              -- first ~280 chars; for fast preview
);

CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_pinned ON memories(pinned);

CREATE TABLE memory_scope (
  memory_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- 'file' | 'tag'
  value      TEXT NOT NULL,
  PRIMARY KEY (memory_id, kind, value),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX idx_scope_lookup ON memory_scope(kind, value);

CREATE TABLE memory_links (
  src_id     TEXT NOT NULL,
  dst_id     TEXT NOT NULL,
  rel_type   TEXT NOT NULL,               -- supports | contradicts | refines | depends_on
  created_at TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_id, rel_type),
  FOREIGN KEY (src_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX idx_links_src ON memory_links(src_id);
CREATE INDEX idx_links_dst ON memory_links(dst_id);

CREATE TABLE memory_audit (
  memory_id      TEXT NOT NULL,
  version        INTEGER NOT NULL,
  ts             TEXT NOT NULL,
  change_type    TEXT NOT NULL,           -- create | update | promote | deprecate | restore | merge | trash | untrash | purge | scope_change | link_add | link_remove
  prev_body_hash TEXT,
  prev_body      TEXT,                    -- nullable; populated only when type opts in via registry config
  reason         TEXT,
  agent_id       TEXT,                    -- free-form: 'claude-code', 'cursor', 'cli-user', etc.
  PRIMARY KEY (memory_id, version)
);

-- FTS5 virtual table for keyword fallback
CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  title,
  body_excerpt,
  content='memories',
  content_rowid='rowid'
);
```

`memory_audit` is **never deleted from**. When a memory is purged from disk, the audit row stays — providing a permanent "memory X existed and was removed" trail.

`memory_links` rows are deleted via foreign-key cascade when either endpoint is purged (not when deprecated or trashed — those preserve edges for audit).

---

## Lifecycle

### State machine

```
                      ┌─── (auto-extracted) ───┐
                      │                         ▼
                      │                    ╔═════════╗
                      │                    ║candidate║
                      │                    ╚════╤════╝
                      │     promote (signals ≥) │   age 90d
                      │     ┌───────────────────┘   └─────────┐
                      │     ▼                                  ▼
       (explicit) ═══►╬═►╔════════╗  deprecate  ╔══════════╗  age 180d  ╔════════╗  age 90d
                      └─►║ active ║◄────────────╣deprecated║───────────►║trashed ║──► (purged,
                         ╚═══╤════╝   restore   ╚══════════╝            ╚════╤═══╝     audit row
                             │                                               │          stays)
                             │ merge                                         │ untrash
                             ▼                                               │
                        ╔════════════╗  age 90d                              ▼
                        ║merged_into ║──────────────► trashed            ╔════════╗
                        ╚════════════╝                                   ║ active ║
                                                                         ╚════════╝
                             ▲
                             │ scope file deleted from repo (indexer post-pass)
                       ╔══════════════════╗
                       ║stale_reference   ║───┬──► review fixes scope ──► active
                       ╚══════════════════╝   └──► review confirms gone ─► deprecated
```

### Transition table

| From → To | Trigger | Caller |
|---|---|---|
| (none) → `candidate` | auto-extractor finds repeated pattern across sessions | session compactor |
| (none) → `active` | `record_memory({ source: "explicit" })` | agent or user |
| `candidate` → `active` | promotion signals met | promotion sweep, or `confirm_memory(id)` |
| `candidate` → `trashed` | not promoted within 90d | aging sweep |
| `active` → `deprecated` | `deprecate_memory(id, reason)` | agent or user |
| `active` → `merged_into` | merge of two memories | `merge_memories(srcId, dstId, mergedBody)` |
| `active` → `stale_reference` | scope file deleted from repo | indexer post-pass |
| `deprecated` → `active` | `restore_memory(id)` | agent or user |
| `deprecated` → `trashed` | aged > 180d | aging sweep |
| `merged_into` → `trashed` | aged > 90d | aging sweep |
| `stale_reference` → `active` | scope updated to existing path | `update_scope(id, files, tags)` |
| `stale_reference` → `deprecated` | review confirms gone | `deprecate_memory(id, reason)` |
| `trashed` → `active` | `untrash_memory(id)` within 90d | agent or user |
| `trashed` → (purged) | aged > 90d | purge sweep (audit row remains forever) |

### Promotion signals (`candidate` → `active`)

Any **one** of these promotes:

1. **Explicit confirm** — `confirm_memory(id)` called by agent or user. Sets `confidence = 1.0`.
2. **Re-extraction stability** — auto-extractor produced a similar candidate (cosine ≥ 0.92, same type, ≥1 tag overlap) in **≥3 distinct sessions** post-creation. Each re-extraction appends a provenance row and bumps `confidence` by 0.10 (capped at 0.95 — only explicit confirm reaches 1.0).

`use_without_contradiction` (retrieval succeeded, no correction in session pointing at the scope) is **deferred**. Heuristic, hard to attribute, easy to misfire.

Default thresholds, configurable per type in `memory.promotion.<type>.*`:

| Type | `re_extraction_promote_count` |
|---|---|
| `decision` | 5 (high stakes) |
| `gotcha` | 3 |
| `pattern` | 2 |
| `how-to` | 3 |

### Versioning and audit

- Every body or scope mutation increments `version` and appends an audit row.
- `prev_body_hash` is always recorded.
- `prev_body` (full text) is stored only when the type's registry config sets `auditPreserveBody: true` — useful for `decision`, wasteful for `pattern`. Default: false.

---

## Relationships

### Lifecycle pointers (frontmatter, 1:1)

- `supersedes: [memory_id, ...]` — what this replaced (audit; rare)
- `mergedInto: memory_id | null` — only when status=`merged_into`
- `promotedFrom: [{repoKey, memoryId}, ...]` — only on global memories that came from project promotion

### Graph edges (sqlite, many:many)

Stored in `memory_links`. Four edge types in v1:

| Edge type | Semantics | Example |
|---|---|---|
| `supports` | A reinforces / cites B | A how-to that implements a decision |
| `contradicts` | A conflicts with B | Two patterns describing the same code path differently |
| `refines` | A is a more specific version of B | Linux-specific gotcha refining a generic concurrency rule |
| `depends_on` | A only makes sense if B holds | A workaround whose validity rests on a particular decision |

Edges persist across status transitions. Default retrieval filters edges to endpoints where `status ∈ {active, candidate}`. Inspecting the full graph (including dead edges) is opt-in. Edges are deleted only when either endpoint is **purged** (FK cascade).

Edge weights and graph-walk ranking are deferred — the linear ranker's `link_boost` (Section: Retrieval) covers v1 needs.

---

## Provenance

Provenance is the bridge between memory and the existing `history/` layer (see Section: Goal — sessions are evidence; memory references them).

### Shape

```yaml
provenance:
  - sessionId: s-2026-04-21-7c3e
    turn: 42
    kind: user_correction              # mirrors EvidenceLayer kind
    excerpt: "..."                      # optional cached text
```

### Excerpt policy

- **Explicit memories**: `excerpt` omitted by default. The user just said it; the body already captures it.
- **Extracted memories**: `excerpt` populated. Auto-extractor needs to justify itself, and the source session may be pruned by retention before a human reviews the candidate.

### Append-only growth

```ts
add_evidence(memoryId, { sessionId, turn, kind, excerpt? })
```

Each subsequent session that reproduces a candidate's pattern appends a provenance row — the mechanism behind re-extraction promotion.

### When the source session is gone

History has its own retention. If a `provenance.sessionId` no longer resolves:
- The entry stays as a tombstone.
- Retrieval ignores tombstoned entries for ranking signals.
- The audit story is preserved via `excerpt` (when present) and the audit log.

---

## Auto-extractor

### Module

`src/lib/history/extract.ts`. Reads compacted session output (not raw transcripts), writes candidate memories via `record_memory`. No special schema — `source: "extracted"` and `status: "candidate"` are the only differentiators.

### Triggers

1. **Per-session, hook-driven (primary).** Existing `SessionEnd` / `PreCompact` Claude Code hooks invoke `ai-cortex history capture`. Extend the hook chain: after capture, run extraction. Latency budget: a few hundred ms; runs after the session ends.
2. **On-demand admin.** `ai-cortex memory extract --session <id>` or `--since <date>`.
3. **Bootstrap (one-shot).** `ai-cortex memory bootstrap` over all existing sessions. See Section: Bootstrap.

Periodic batch (cron-style) **deferred** — per-session covers steady state.

### Inputs

The session's `EvidenceLayer` (`toolCalls`, `filePaths`, `userPrompts`, `corrections`) plus `summary`. Never reads raw transcripts directly — extractor decoupled from harness format.

### Heuristics per type (v1)

Rule-based and regex-heavy. Confidence reflects signal strength; nothing extracted ranks against active memories until promotion.

| Target type | Trigger pattern | Body source | Scope source | Initial confidence |
|---|---|---|---|---|
| `decision` | A `correction` containing imperative cues (`must`, `always`, `never`, `should`, `don't`, `prefer`) followed by user/agent acknowledgment within 2 turns | Correction text + 1-line context | Files referenced ±3 turns; tags from keyword extraction | 0.55 (with ack) / 0.45 (without) |
| `gotcha` | A `correction` containing symptom cues (`breaks`, `fails`, `race`, `hangs`, `wrong`, `bug`, `flaky`) AND a subsequent turn with workaround language (`fix`, `instead`, `workaround`) | Correction + workaround turn | File mentioned nearest the correction | 0.55 |
| `pattern` | Cross-session co-occurrence: same file set in `filePaths` across ≥3 sessions with similar query language (cosine on userPrompts ≥ 0.7) | Generated from co-occurring files + session summaries | The co-occurring files | 0.35 |
| `how-to` | `userPrompt` matching `^(how (do|to|can) i)|^(steps|process|procedure)` followed by ≥3 sequential tool calls AND closing assistant turn with numbered list | Numbered list from closing turn | Files touched in the tool calls | 0.50 |

These heuristics are explicitly fragile starting points. The whole pipeline is gated by the `candidate` lifecycle state; the dedup + aging story is the safety net.

### Cross-session deduplication

The single most important step. Without it, the same insight produces N candidates over N sessions.

For each newly produced candidate:

1. Embed the candidate body.
2. Query existing memories in the same store (`active` + `candidate`) for nearest neighbor by cosine.
3. If `cosine ≥ 0.85` AND `type` matches AND `tags ∩ candidate_tags ≠ ∅`:
   - **Don't create.** Call `add_evidence(existingId, ...)` with the new session's pointer.
   - Bump existing memory's `confidence` by 0.10 (capped at 0.95).
   - This is the re-extraction promotion signal.
4. Else: create a new candidate.

Threshold tunable in `memory.extractor.dedupCosine` (default 0.85).

### Out of scope (v1)

- Anti-pattern detection (avoiding X without saying so).
- Project- vs universal-truth classification (everything goes to project; promotion to global is manual).
- Decisions buried in long prose.
- Multi-turn nuanced clarifications (will produce noisy candidates; aging is the safety net).

### Observability

Per-session manifest written to `~/.cache/ai-cortex/<repoKey>/memory/extractor-runs/<sessionId>.json`:

```jsonc
{
  "version": 1,
  "sessionId": "s-2026-04-29-9d11",
  "runAt": "2026-04-30T10:14:00Z",
  "candidatesCreated": 2,
  "evidenceAppended": 3,
  "rejectedCandidates": [
    { "type": "decision", "reason": "below confidence floor 0.4", "previewText": "..." }
  ]
}
```

Inspectable via `ai-cortex memory extractor-log <sessionId>`. Critical for tuning heuristics later.

---

## Retrieval

### Two-stage: filter then rank

**Stage 1 — Sqlite filter.** Returns up to 200 candidate memories.

The scope filter has two cases. (a) The query carries **no** scope filter (both `:files` and `:tags` are null/empty): every status-eligible memory passes. (b) The query carries **a** scope filter: a memory passes if its scope row matches *any* provided file or tag, or if it has *no* scope rows at all (project-wide memories are always eligible under any scoped query).

```sql
-- attach global, then UNION across project + global
SELECT m.id, m.type, m.status, m.confidence, m.updated_at, m.body_hash
FROM memories m
WHERE m.status IN ('active', 'candidate')
  AND (:type_filter IS NULL OR m.type IN (:types))
  AND (
    -- (a) no scope filter at all → every memory eligible
    (:has_scope_filter = 0)

    -- (b) scope filter present → match any provided file/tag, or project-wide memory
    OR EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=m.id AND s.kind='file' AND s.value IN (:files))
    OR EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=m.id AND s.kind='tag'  AND s.value IN (:tags))
    OR NOT EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=m.id)
  )
LIMIT 200;
```

The caller precomputes `:has_scope_filter` (1 if either `files` or `tags` was non-empty in the request, else 0). Avoids the bug where `:files IS NULL AND :tags IS NOT NULL` accidentally accepts every memory regardless of tag match.

**Stage 2 — In-memory linear ranker.**

```
score =   0.50 * cos(query_embedding, body_embedding)        # semantic match
        + 0.30 * scope_match                                  # 1.0 file hit | 0.5 tag hit | 0.2 project-wide
        + 0.10 * status_weight                                # active=1.0 | candidate=0.5 | stale_reference=0.3
        + 0.05 * confidence                                   # 0.0–1.0
        + 0.05 * recency_decay                                # exp(-days_since_updated / 60)
        + 0.10 * source_boost                                 # 1.0 if project (vs global merged in)
        + 0.05 * link_boost                                   # 1.0 if linked (supports|refines) to another retrieved memory

       - 0.20 * type_mismatch_penalty                         # if query implies how-to and result isn't, etc.
```

Weights live in `memory.ranking.weights.*`. Defaults above are starting points — tunable without code changes.

Top-K returned (default 10). Each result: `{ id, title, type, status, scope, body_excerpt, score, links: [{type, dst_id}] }`. Full body fetched on demand via `get_memory(id)` — keeps the recall response lean.

### Keyword fallback

`search_memories(query)` uses the `memory_fts` virtual table directly — for cases where literal terms matter (file paths, function names, error strings) and embedding cosine misses.

---

## Injection

### Pull (primary)

Agents call `recall_memory` exactly like `suggest_files`. Same UX as the rest of ai-cortex. The agent decides when memory is relevant.

### Auto-inject (rehydration briefing)

The existing `rehydrate_project` MCP tool gets a new section: **Pinned memories**. Selected by:

- `status = active`
- `pinned = true` in frontmatter (explicit pinning), OR
- Project-wide (no `scope.files`) AND `type ∈ {decision, gotcha}` AND `confidence ≥ 0.9`

Top-K by `confidence × recency_decay`, default K=5.

Hard cap: 20 pinned memories project-wide. Soft warning at 10. Agent can pin past 20 only via `pin_memory(id, { force: true })`.

Briefing fragment example:

```markdown
## Pinned memories (5)

- **decision** — Cache writes use atomic temp-file rename
  > All writes under `~/.cache/ai-cortex/<repoKey>/` write to `.tmp` then `rename()`. (mem-2026-04-30-cache-atomic-writes)

- **gotcha** [critical] — Parser must init before parallel adapter factories on Linux
  > Call `await Parser.init()` once at module load... (mem-2026-04-29-parser-init-race-linux)
```

---

## Aging and dump policy

Aging runs as a single sweep on session start (or via `sweep_aging`). All thresholds in `memory.aging.*` config; numbers below are defaults.

| State | Trigger | Action | Default |
|---|---|---|---|
| `candidate` | not promoted in N days | → `trashed` | 90d |
| `candidate` (low-conf) | confidence < 0.4 AND never retrieved AND > N days | → `trashed` | 90d |
| `deprecated` | aged > N days | → `trashed` | 180d |
| `merged_into` | aged > N days | → `trashed` | 90d |
| `trashed` | aged > N days | → purged (file deleted; audit row stays) | 90d |
| `stale_reference` | — | **never auto-aged**; needs human/agent review | — |

`sweep_aging({ dryRun: true })` previews actions without applying them.

### Two-stage delete (trash → purge)

1. `trash_memory(id, reason)` moves the `.md` from `memories/` to `trash/`. Index marks `status = trashed`. Removed from retrieval. **Recoverable via `untrash_memory(id)` for 90d.**
2. After 90d, sweep hard-deletes the file. `memory_audit` row remains forever.
3. `purge_memory(id, reason)` skips trash and hard-deletes immediately. Reserved for privacy/sensitive content.

---

## Two-tier storage

### Project store

Default. Lives at `~/.cache/ai-cortex/<repoKey>/memory/`. Project-scoped knowledge.

### Global store

Lives at `~/.cache/ai-cortex/global/memory/`. Cross-project knowledge: language gotchas, tool quirks, recurring patterns.

### Querying

For project queries: `ATTACH DATABASE` global, query both, merge in stage 2. Project memories receive `+0.10` source_boost in the ranker (specific wins on ties).

Global-only queries: `recall_memory({ source: "global" })` for the user-curated cross-project view.

### Promotion (project → global)

In v1: **manual only.**

- `record_memory({ scope: { global: true }, ... })` writes directly to global. **Note:** `scope.global` is an API-level routing parameter, *not* a frontmatter field — it tells `lifecycle.create` which store to write to. The stored memory carries no `global` field; its location (`global/memory/memories/`) is the scope marker.
- `promote_to_global(memoryId)` re-homes a project memory: copies it to global with a `promotedFrom` backref; the original gets `status = merged_into`, `mergedInto = <global-id>`.

**Auto-promotion** (cross-project compactor that detects similar memories across multiple repoKeys and proposes global candidates) is **deferred to v2**. Triggers to revisit: manual promotion stops scaling, or specific cross-project gotchas surface repeatedly.

### Distinguishing from existing memory surfaces

ai-cortex global memory is for **agent-derived knowledge** (gotchas, patterns the agent observed, decisions across projects).

Out of scope and untouched by v1:
- `~/.claude/CLAUDE.md` user instructions (harness reads, user-edited)
- `~/.claude/projects/<encoded-cwd>/memory/` Claude auto-memory (harness writes, user-edited)

These could integrate later; for v1 ai-cortex memory is its own surface.

---

## Bootstrap — extracting from existing history

You will already have thousands of session files when v1 lands. Bootstrap is the one-shot path that brings them into memory:

```
ai-cortex memory bootstrap [--repo <path>] [--limit-sessions N] [--min-confidence X]
```

What it does:
1. Reads existing `~/.cache/ai-cortex/<repoKey>/history/sessions/*/session.json`.
2. Runs the auto-extractor over each session.
3. Clusters similar candidates across sessions (cosine ≥ 0.92, type match, tag overlap) into single memories with multi-evidence provenance.
4. Writes them as `status = candidate`, `confidence ≤ 0.6`.

Conservative by design: it produces a candidate flood, not active memories. Agents see them ranked low. Over time, re-extraction or explicit confirms promote the real ones; aging sweeps the noise. Bootstrap is **idempotent** — re-running adds new evidence to existing candidates rather than duplicating.

---

## API surface

### MCP tools — read

| Tool | Purpose | Returns |
|---|---|---|
| `recall_memory(query, options?)` | Primary retrieval. Hybrid filter + vector rank. | Top-K memories with `id, title, type, status, scope, body_excerpt, score, links` |
| `get_memory(id)` | Fetch full body by ID. | Full markdown body + frontmatter |
| `list_memories(filters?)` | Admin/inspection — filter by type/status/scope/date. | Lightweight list (no body) |
| `search_memories(query)` | Keyword/FTS5 search. | Top-K by FTS5 rank |
| `audit_memory(id)` | Show full version history of a memory. | Audit log rows |

`recall_memory` options:

```ts
{
  scope?: {
    files?: string[];
    tags?:  string[];
  };
  type?: ("decision" | "gotcha" | "pattern" | "how-to" | string)[];
  includeStatus?: ("active" | "candidate" | "deprecated")[];   // default: active + candidate
  limit?: number;          // default 10
  source?: "project" | "global" | "all";   // default: "all"
}
```

### MCP tools — write

```ts
// create
record_memory(input)                       // → mem id (status: active or candidate)
add_evidence(id, { sessionId, turn, kind, excerpt? })

// promote / refine
confirm_memory(id)                         // candidate → active, confidence → 1.0
update_memory(id, patch)                   // body/scope mutation; bumps version, appends audit
update_scope(id, { files?, tags? })        // common-case helper

// retire
deprecate_memory(id, reason)
restore_memory(id)
merge_memories(srcId, dstId, mergedBody)
trash_memory(id, reason)
untrash_memory(id)
purge_memory(id, reason)                   // privacy-grade hard delete

// graph
link_memories(srcId, dstId, type)          // type ∈ supports|contradicts|refines|depends_on
unlink_memories(srcId, dstId, type)

// pinning
pin_memory(id, { force?: boolean })        // force overrides 20-cap soft limit
unpin_memory(id)

// scope migration
promote_to_global(id)

// admin
sweep_aging({ dryRun?: boolean })
rebuild_index()
```

### CLI

```
ai-cortex memory recall "<query>" [--type T] [--limit N] [--source project|global|all]
ai-cortex memory get <id>
ai-cortex memory list [--type T] [--status S] [--scope <file>]
ai-cortex memory record --type T --title "..." --body-file F [--scope-file F]... [--tag T]...
ai-cortex memory update <id> [--body-file F] [--add-tag T] [--remove-tag T]
ai-cortex memory confirm <id>
ai-cortex memory deprecate <id> --reason "..."
ai-cortex memory restore <id>
ai-cortex memory merge <srcId> <dstId> --body-file F
ai-cortex memory trash <id> --reason "..."
ai-cortex memory untrash <id>
ai-cortex memory purge <id> --reason "..." --yes
ai-cortex memory promote <id>                      # → global
ai-cortex memory pin <id> | unpin <id>
ai-cortex memory link <src> <dst> --type supports
ai-cortex memory sweep [--dry-run]
ai-cortex memory audit <id>
ai-cortex memory rebuild-index
ai-cortex memory bootstrap [--repo <path>] [--limit-sessions N]
ai-cortex memory extract --session <id>
ai-cortex memory extractor-log <sessionId>
```

`record` and `update` accept `--body-file -` for stdin. Avoids escaping nightmares.

---

## Configuration

All under `memory.*` namespace, layered: defaults in code → `~/.config/ai-cortex/config.json` → per-repo `<repoKey>/memory/config.json` (highest precedence).

```jsonc
{
  "memory": {
    "aging": {
      "candidate_to_trashed_days": 90,
      "deprecated_to_trashed_days": 180,
      "merged_into_to_trashed_days": 90,
      "trashed_to_purged_days": 90,
      "low_confidence_threshold": 0.4
    },
    "promotion": {
      "decision":  { "re_extraction_promote_count": 5 },
      "gotcha":    { "re_extraction_promote_count": 3 },
      "pattern":   { "re_extraction_promote_count": 2 },
      "how-to":    { "re_extraction_promote_count": 3 }
    },
    "extractor": {
      "dedupCosine": 0.85,
      "reExtractionMatchCosine": 0.92
    },
    "ranking": {
      "weights": {
        "semantic": 0.50, "scope": 0.30, "status": 0.10,
        "confidence": 0.05, "recency": 0.05, "source": 0.10,
        "link": 0.05, "type_mismatch_penalty": 0.20
      },
      "recency_half_life_days": 60,
      "candidate_pool_size": 200,
      "top_k": 10
    },
    "injection": {
      "pinned_hard_cap": 20,
      "pinned_soft_warn": 10,
      "auto_inject_top_k": 5
    }
  }
}
```

---

## Concurrency and atomicity

- **`.md` writes**: temp-file + rename (matches `cache-store.ts`).
- **Sqlite**: WAL mode. Concurrent readers under one writer. Memory writes are infrequent — no contention concerns at v1 scale.
- **Index drift**: detected by `body_hash` mismatch on read; triggers single-record re-index, never blocks the reader.
- **Lock files**: not introduced. Reuse the existing per-session lock pattern from `history/store.ts` only if multi-process write contention surfaces (unlikely; MCP server is single-process per session).

---

## Tradeoffs

### Kept simple

- **Single vector per memory.** Reuses existing Xenova path. ~5ms cosine over thousands of memories. Zero new model dependencies.
- **JSON for `types.json`.** Tiny (kilobytes), human-edited, no index needed.
- **Linear weighted ranker.** Hand-tunable, debuggable. No ML training loop.
- **Body conventions, not validation.** Section headings are recommendations; agents ignoring them still produce valid memories.
- **Lifecycle pointers in frontmatter, edges in sqlite.** Lifecycle is 1:1 (file owns it); edges are many:many (table is right shape).

### Justified complexity

- **6 lifecycle states.** Tempting to collapse, but each state represents a meaningfully different retrieval/aging behavior. Removing any breaks an audit story.
- **Audit log with `prev_body_hash` + opt-in `prev_body`.** Hash is 32 bytes; body is variable. Per-type opt-in keeps total storage bounded while letting `decision` types preserve full rollback.
- **Two-stage delete (trash → purge).** Single-stage hard delete is one bad sweep away from data loss. Trash is a free safety net.
- **Two-tier storage (project + global).** Adds the merged-query path but pays for itself the first cross-project gotcha.

### Deferred

| Deferred | Why | Trigger to revisit |
|---|---|---|
| Auto cross-project promotion | Needs cross-store crawler, similarity clustering, contradiction handling. | Manual `promote_to_global` stops scaling. |
| `use_without_contradiction` promotion signal | Heuristic, hard to attribute, easy to misfire. | Re-extraction stability proves insufficient. |
| Symbol-level and line-range scope | Symbol identity fragile; line ranges rot on edit. | File-level scope ranks too coarsely. |
| Edge weights and graph-walk ranking | Linear `link_boost` covers most value. | Retrieval clearly under-uses relationships. |
| Per-section embedding | Single vector simpler; embeddings cheap. | Long memories rank poorly because most body is irrelevant to query. |
| Memory templates | Conventions are not enforced; not blocking. | Authoring fatigue surfaces. |
| Web UI | `.md` files inspectable; CLI covers admin. | Users actually want it. |
| Encryption at rest | Out of scope for local-first. | Compliance need surfaces. |
| Periodic batch extraction (cron) | Per-session covers steady state. | Per-session triggers prove unreliable. |

---

## Test plan

Unit:
- `store.ts` — atomic write, drift detection, dir layout, repo isolation.
- `index.ts` — sqlite schema, audit append, scope filter queries, FK cascade on purge.
- `lifecycle.ts` — every transition in the state machine; promotion signals; merge mechanics.
- `aging.ts` — sweep policy at boundaries (89d/90d/91d), dry-run, stale_reference exclusion.
- `registry.ts` — built-in types preserved, user types validated, frontmatter validation per-type.
- `embed.ts` — vector update on body change, sidecar consistency.
- `retrieve.ts` — stage-1 filter correctness; stage-2 ranker math; tie-breaking (project > global on equal score).
- `extract.ts` — heuristic per type on synthetic sessions; dedup logic at threshold boundaries; provenance append on dedup hit.

Integration:
- End-to-end: explicit write → recall → confirm cycle.
- End-to-end: extracted candidate → re-extraction across 3 sessions → auto-promotion to active.
- Bootstrap over a synthetic history of 50 sessions; verify candidate counts and dedup behavior.
- Two-tier query: project + global merge with ranker boost validation.
- Sweep aging with multi-state fixture (candidate, deprecated, merged_into, trashed, stale_reference).

E2E (existing eval harness):
- Memory injection into rehydration briefing visible in MCP output.
- `recall_memory` ranks correctly against fixed query/scope/expected-id ground truth.
- Audit log preserves full history across simulated update/deprecate/restore/merge/trash/purge sequence.

---

## Open questions / future work

Listed for explicit visibility in implementation planning. Defaults proposed; speak up during implementation if any need adjusting.

1. **Memory ID format.** `mem-YYYY-MM-DD-<slug>`; slug is kebab-case from title, ≤40 chars, UTC creation date.
2. **`agent_id` in audit log.** Free-form string set by caller (`claude-code`, `cursor`, `cli-user`, etc.). No registry.
3. **Vector regeneration on body update.** Inline on `update_memory`; ~50ms with Xenova. Acceptable write-time cost.
4. **Type registry mutation.** Adding a built-in type requires code change. Adding a user type is purely declarative (`types.json` edit).
5. **Body length cap.** None enforced. Body excerpt cap is 280 chars in the index. Long bodies still searchable via `get_memory`.
6. **Tag normalization.** Tags lowercased, hyphenated; no stop-list in v1.

---

## Appendix — Worked examples (one per type)

### `decision`

```markdown
---
id: mem-2026-04-30-cache-atomic-writes
type: decision
status: active
title: Cache writes use atomic temp-file rename
version: 3
createdAt: 2026-04-21T14:02:11Z
updatedAt: 2026-04-30T09:18:44Z
source: explicit
confidence: 1.0
pinned: false
scope:
  files: [src/lib/cache-store.ts, src/lib/history/store.ts]
  tags:  [caching, atomicity, durability]
provenance:
  - sessionId: s-2026-04-21-7c3e
    turn: 42
    kind: user_correction
supersedes: []
mergedInto: null
deprecationReason: null
promotedFrom: []
---

## Rule
All writes under `~/.cache/ai-cortex/<repoKey>/` write to a `.tmp` file first, then `rename()` atomically.

## Why
Crash mid-write must leave the prior version intact. Partial JSON or SQLite files are not recoverable from heuristics — agents would either silently use bad data or refuse to start. Hit in 2025-Q4 when a SIGKILL during a refresh left `index.json` half-written; the next session crashed in `JSON.parse`.

## Alternatives considered
- **Write-then-fsync without rename** — same window where readers see partial bytes.
- **Lockfile gating reads** — extra complexity for cross-process coordination; rename is a single syscall.
```

### `gotcha`

```markdown
---
id: mem-2026-04-29-parser-init-race-linux
type: gotcha
status: active
title: Parser must init before parallel adapter factories on Linux
version: 1
createdAt: 2026-04-29T11:08:00Z
updatedAt: 2026-04-29T11:08:00Z
source: explicit
confidence: 1.0
pinned: true
severity: critical
scope:
  files: [src/lib/adapters/index.ts]
  tags:  [linux, concurrency, tree-sitter, ci]
provenance:
  - sessionId: s-2026-04-29-9d11
    turn: 31
    kind: user_correction
supersedes: []
mergedInto: null
deprecationReason: null
promotedFrom: []
---

## Symptom
On Linux CI runners, the indexer fails intermittently with `Parser is not initialized` when adapter factories run in parallel. macOS does not reproduce.

## Cause
tree-sitter's WASM Parser global state is initialized lazily by the first `new Parser()`. When N factories race the constructor on Linux, only one wins the init; the others race ahead with an uninitialized binding. macOS WASM threading happens to serialize this; Linux does not.

## Workaround
Call `await Parser.init()` once at module load in `src/lib/adapters/index.ts` before any factory runs. Already in place — do not remove.

## How to detect
Indexer fails on Linux CI with `Parser is not initialized`, passes on macOS. Stack trace bottoms out in tree-sitter WASM glue.
```

### `pattern`

```markdown
---
id: mem-2026-04-15-suggest-ranker-layout
type: pattern
status: active
title: Suggest rankers — fast / deep / semantic split
version: 2
createdAt: 2026-04-15T08:00:00Z
updatedAt: 2026-04-18T14:30:00Z
source: extracted
confidence: 0.85
pinned: false
scope:
  files:
    - src/lib/suggest-ranker.ts
    - src/lib/suggest-ranker-deep.ts
    - src/lib/suggest-ranker-semantic.ts
  tags: [suggest, ranking]
provenance:
  - sessionId: s-2026-04-15-3f02
    turn: 14
    kind: tool_call
  - sessionId: s-2026-04-18-5ae7
    turn: 8
    kind: tool_call
supersedes: []
mergedInto: null
deprecationReason: null
promotedFrom: []
---

## Where
Three ranker modules, one strategy each:
- `suggest-ranker.ts` — fast: path heuristics + fn names + call-graph hops.
- `suggest-ranker-deep.ts` — fast + trigram + content scan over a candidate pool.
- `suggest-ranker-semantic.ts` — sentence embeddings (Xenova MiniLM L6 v2).

## Convention
- Each ranker exports `rank()` returning `{ files: RankedFile[] }`.
- CLI/MCP layer chooses which to call; rankers don't know about each other.
- Adding a strategy = new file `suggest-ranker-<strategy>.ts` + register in `suggest.ts`.

## Examples
- `suggest_files` MCP tool → `suggest-ranker-deep.ts` (default).
- `suggest_files_semantic` MCP tool → `suggest-ranker-semantic.ts`.
```

### `how-to`

```markdown
---
id: mem-2026-04-28-add-language-adapter
type: how-to
status: active
title: Add a new language adapter
version: 1
createdAt: 2026-04-28T16:00:00Z
updatedAt: 2026-04-28T16:00:00Z
source: explicit
confidence: 1.0
pinned: false
scope:
  files: [src/lib/lang-adapter.ts, src/lib/adapters/index.ts]
  tags:  [adapters, extensibility]
provenance:
  - sessionId: s-2026-04-28-2c81
    turn: 53
    kind: tool_call
supersedes: []
mergedInto: null
deprecationReason: null
promotedFrom: []
---

## Goal
Add support for a new language to the indexer (e.g., Rust, Go).

## Steps
1. Create `src/lib/adapters/<lang>.ts` implementing the `LangAdapter` interface from `src/lib/lang-adapter.ts`.
2. Use a tree-sitter grammar. Do **not** call `new Parser()` from inside the factory — rely on the module-level init in `src/lib/adapters/index.ts` (see `mem-2026-04-29-parser-init-race-linux`).
3. Register the factory in `src/lib/adapters/index.ts` keyed by file extension.
4. Add a fixture under `tests/fixtures/adapters/<lang>/`.
5. Add unit tests in `tests/lib/adapters/<lang>.test.ts`.
6. Run the indexer against the fixture and confirm symbols populate.

## Verification
- `pnpm test` passes the new adapter test.
- `ai-cortex index <fixture-path>` produces non-empty symbol output.
- `blast_radius` returns expected callers for a known fixture function.
```
