# Phase 11 — Adoption telemetry — design

**Date:** 2026-05-19
**Status:** design — phased; see §10
**Scope:** per-session adoption signal: `session_id` on stats `tool_calls`; a cache-only surface-hook telemetry stream; a shared aggregation core; a CLI report and a TUI panel.
**Builds on:** post-v0.9.1 tree (`stats tool_calls` schema v2; the v0.9.1 `cacheMeta` sidecar is unrelated to `tool_calls` — no interaction). High-level plan Phase 11.

---

## 1. Context & problem

`ai-cortex stats` already aggregates `tool_calls` **per project, windowed** (latency, cache mix, a project-level `recall→get` ratio). What it cannot answer is the plan's Phase 11 gate: *"did the agent use memory **this session**?" — a number, not a feeling.* The blocker is structural: `tool_calls` (schema v2: `ts, tool, dur_ms, status, err_*, cache_status, mode, result_count, query_len, meta, synthetic`) has **no `session_id`**, so events cannot be grouped by session. Separately, the v0.9.0 edit-time surface hook — the feature whose effectiveness most needs measuring — is a distinct CLI process, never recorded in `tool_calls` at all.

So Phase 11's "~1 day, just aggregate existing traces" assumption is false: the session dimension does not exist, and the surface path is unmeasured.

## 2. Goals / non-goals

### Goals
- Attribute MCP tool calls to a session (`session_id` on `tool_calls`, best-effort, nullable).
- Measure v0.9.0 surface-hook effectiveness (was a surfacing followed by a consult, same session).
- A shared, tested aggregation core; a CLI report (`--json` for CI) and a TUI panel, both thin presenters over it.
- Answer "did the agent use memory this session?" as a number, **honestly** — surface the fraction of un-attributable events so a weak number isn't read as ground truth.

### Non-goals
- **No behavior change** to any MCP tool or to the edit gate — pure observability.
- **No `better-sqlite3` / native dep in the PreToolUse hot path** (the surface hook stays bounded/dependency-free).
- No closed-loop confidence reconciliation (that is Phase 12).
- No network/upload — local-only, consistent with the stats privacy contract.
- No retroactive attribution of pre-v3 **live** rows (the session was never captured at write time → stay NULL → `(unattributed)`). **In scope:** the existing `stats backfill` path *does* know each session id (the session dir name `e.name`), so backfilled **synthetic** rows are written with `session_id = e.name` — otherwise running `backfill` would immediately inflate `unattributed`. Precise (surfaced-id → `get_memory(id)`) correlation is **deferred** (see §6, §12) — coarse only in v1.

## 3. Architecture (Approach B — two sources, joined at aggregation)

```
MCP tool call ──logged()──> stats sink (sqlite tool_calls + session_id)  ┐
                                                                          ├─ loadSessionAdoption() ─┬─ CLI report
edit-time surface (emit) ──> cache JSONL  adoption/surface-events.jsonl   ┘   (shared core)          └─ TUI panel
```

Two capture layers, independent and additive; one aggregation core; two thin presenters. The surface side deliberately does **not** touch sqlite — it appends a cache-only JSONL line exactly like `surface-ledger.ts`, preserving the hook's latency/dependency contract. The MCP side reuses the sink the server already opens.

## 4. MCP session-id substrate

- `src/lib/stats/sink.ts`: `tool_calls` schema **v2 → v3**, add `session_id TEXT` (nullable). `migrate()` gains a v2→v3 step: `ALTER TABLE tool_calls ADD COLUMN session_id TEXT` if absent, then `user_version = 3`. Idempotent; pre-v3 live rows default NULL; mirrors the existing v1→v2 `synthetic` migration. `SCHEMA_SQL` for fresh DBs includes the column; `SCHEMA_VERSION = 3`. `StatsEvent` (`types.ts`) gains optional `session_id?: string | null`.
- **Prepared-statement fallback (critical — `openSink` prepares one fixed insert at sink.ts:59, *outside* `writeEvent`'s try; a v3-shaped prepare after a failed ALTER would throw "no such column" and break the whole sink):** after `migrate(db)`, `openSink` runs `PRAGMA table_info(tool_calls)` and prepares **either** the v3 insert (with `session_id`) **iff** the column exists, **or** the legacy 12-col insert otherwise. `StatsSink` records which shape was prepared; `writeEvent` includes the `session_id` param only for the v3 statement. So a failed/blocked migration degrades to legacy logging (no `session_id`) instead of crashing the sink — and existing MCP logging is never broken.
- `src/mcp/server.ts` `logged()`: resolve session id best-effort. The reliable source is the **environment**, via `detectCurrentSession({ cwd: process.cwd() })` (it reads `AI_CORTEX_SESSION_ID` / `CLAUDE_SESSION_ID` / `CODEX_THREAD_ID` — Claude Code sets `CLAUDE_SESSION_ID` in the MCP server env per `session-detect.ts`). **No `args.sessionId`** — tool input schemas do not carry it (e.g. `get_memory` is `{worktreePath,id}`); `search_history` is the lone tool with an explicit optional `sessionId` and is not a general mechanism. Resolved once per call inside `logged()` and threaded through `StatsEvent.session_id`; undetectable → `NULL` (the 2026-04-25 session-history spec documents harnesses that don't expose it to MCP processes). Wrapped: a resolution failure never affects the tool result (MCP logging is already best-effort).

## 5. Surface-hook telemetry (cache-only, hot-path-safe)

- `src/lib/memory/cli/surface-hook.ts`: only when it actually surfaces (`emit === true`), append one JSONL line to `getCacheDir(repoKey)/adoption/surface-events.jsonl`:
  `{ "ts": <ms>, "session_id": <string|null>, "memoryIds": [<id>...], "count": <n> }`
  `session_id` here is the **harness-provided** PreToolUse stdin `session_id` (already read by `surface-hook.ts`) — more reliably attributed than the MCP env path, so surface events typically have a lower unattributed share than `tool_calls` (the aggregator/§6 accounts for this per-source). No file paths, no bodies (stats privacy contract). Emitted via the same best-effort discipline as `surface-ledger.ts`: `try/catch`, never throws, never blocks the edit, **no `better-sqlite3`/native module** loaded.
- A small util (e.g. `src/lib/stats/surface-events.ts`) owns the path, append, lazy 90d prune (match stats `RETENTION_MS`), and a tolerant line reader (skip malformed). The hook depends only on the append; the reader is used by the aggregation core.
- Dedup-silent surfacings are **not** recorded — only what the agent was actually shown (the input to "did surfacing drive a consult").

## 6. Aggregation core + metric definitions

`src/lib/stats/sessions.ts`: `loadSessionAdoption(repoKey, { windowMs }) → { sessions: SessionRow[], summary: AdoptionSummary }`. Reads `tool_calls` grouped by `session_id` (NULL → a single `(unattributed)` bucket) within the window, parses `surface-events.jsonl` (best-effort), joins by `session_id`. Pure given the two stores; CLI and TUI both call it — no logic in presenters.

**`SessionRow`:** `sessionId` (`"(unattributed)"` for NULL), `firstTs`, `lastTs`, `totalCalls`, per-tool counts (`recall_memory`, `get_memory`, `record_memory`, `extract` = `extract_session` (note: `bootstrap` is a CLI subcommand, not an MCP tool — never in `tool_calls`, excluded by the `tool-names.ts` allowlist), `cleanup` = candidate-resolving actions `rewrite_memory`+`deprecate_memory`+`confirm_memory`), `surfacings` (count of surface-events lines), `surfacedMemoryIds` (union).

**Derived (defined unambiguously):**
- **`memoryUsed`** (headline boolean): `get_memory ≥ 1` OR `record_memory ≥ 1`. No surfaced-id clause — consulting a surfaced memory *is* a `get_memory` call (already counted by clause 1), and v1 cannot do precise surfaced-id→`get_memory(id)` correlation anyway (see surface→get below). `recall_memory` alone is **not** "used" — recall is browse; `get_memory` is the use signal (the project's cardinal pattern). Surfacing effectiveness is measured separately by **surface→get**, not by `memoryUsed`.
- **recall→get conversion** (window): of sessions with ≥1 `recall_memory`, the fraction with a `get_memory` whose `ts` is **strictly after** a `recall_memory` `ts` in the same session.
- **surface→get** (v0.9.0 effectiveness): v1 = **coarse, definitively** — sessions with ≥1 surfacing AND ≥1 `get_memory` whose `ts` is after the surfacing / sessions with ≥1 surfacing. Precise id-match (surfaced id `X` → `get_memory(X)`) is **not possible under the current stats contract** and is explicitly **deferred**, not an implementation-time choice: `StatsEvent`/`StatsResultFields` carry no id, `writeEvent` hardcodes `meta:null`, and `get_memory` is registered with `NO_STATS_RESULT` — so the get target id is never recorded. Precise correlation would require a separate phase: a privacy-reviewed `memory_id` (or constrained `meta`) field on the stats schema + sanitizer + a `get_memory` `extractResult`. Out of v1 scope.
- **extract→cleanup** (window, **project-level, not per-session** — extraction is post-session, cleanup happens in later sessions): `cleanup` action count (rewrite/deprecate/confirm tool calls) ÷ **candidates produced**. The denominator is *not* derivable today — `extract_session` is registered `NO_STATS_RESULT`, so its `tool_calls` row has `result_count = NULL`; a raw "cleanup calls / extract_session calls" ratio would be near-meaningless (extraction runs ~once/session, cleanup is sporadic). Fix is cheap and in v1 scope (no schema change, `result_count` is an existing privacy-safe count column, the count is already in the handler's `manifest`): **`extract_session` swaps `NO_STATS_RESULT` → an `extractResult` returning `{ result_count: <number of NEW candidates the extractor created this run> }`** (new — not total-seen — so re-extract runs that create nothing contribute 0). Metric = `Σ cleanup calls (window) ÷ Σ extract_session.result_count (window)`. Explicitly **approximate**: a cleanup may target a candidate produced outside the window and cohorts aren't tracked — it's a rate, not an exact cohort conversion (the plan asks for a rate). Stated so it isn't over-read.
- **`AdoptionSummary`:** distinct session count; **headline** `% of sessions where memoryUsed`; a small histogram (`memoryUsed` true/false; sessions with 0 / 1 / 2+ memory interactions); recall→get %, surface→get %, extract→cleanup %; **`unattributedShare`** = fraction of windowed events with NULL `session_id` — a first-class data-quality signal shown alongside every number (honest "a number, not a feeling": a high unattributed share means low confidence, surfaced explicitly).

Edge rules: `(unattributed)` counted in totals but flagged; temporal metrics within that bucket are approximate (noted in output). `windowMs` mirrors existing stats windows (1h / 24h / 7d default / 30d).

## 7. CLI presenter

`ai-cortex stats sessions [--window 1h|24h|7d|30d] [--json] [--cwd <path> | --repo-key <key>]` — sibling of the existing `stats backfill`, wired in the `cli.ts` `stats` group via a new `src/lib/stats/cli/sessions.ts`. Default window 7d. Human output: per-session table (short `sessionId`, ts range, `totalCalls`, recall→get?, `memoryUsed`, `surfacings`) + a summary block (headline %, histogram, conversion %s, `unattributedShare`). `--json` emits `{ sessions, summary }` verbatim for scripting/CI. Pure formatter over `loadSessionAdoption`.

## 8. TUI presenter

Add a `[ Sessions ]` tab to the existing `ai-cortex stats` project view (beside `Tools / Memory / Suggest / Storage`). New focused component `src/tui/sessions/SessionsPanel.tsx`, fed by `loadSessionAdoption` through the existing `useStatsTick` polling pattern; reuses existing table/sparkline primitives (the memory-activity sparkline already exists). Renders the headline number, histogram, recall→get / surface→get bars, and the `unattributedShare` flag. Zero duplicated aggregation — same core as the CLI. Tab-strip + navigation wiring follows the existing tab pattern.

## 9. Privacy, retention, error handling

- **Privacy:** `session_id` (random UUID) and memory ids are *identifiers* — allowed by the stats contract ("lengths, counts, identifiers; no query text, no memory bodies, no file paths"). surface-events JSONL carries only `ts / session_id / memoryIds / count`. README "Inspecting performance → Privacy" extended to name `session_id` + surface-events; still local-only, never leaves the machine.
- **Retention:** surface-events JSONL lazy-pruned to the stats 90d `RETENTION_MS` on append/read; `tool_calls` already 90d-pruned by `openSink`.
- **Error handling (inviolable):** session-id undetectable → NULL, never throws, tool unaffected; surface emit failure → swallowed, **edit never blocked** (same as `surface-ledger.ts`); malformed JSONL lines skipped; migration v2→v3 idempotent and must never break MCP logging (degrade to no `session_id`); sqlite read error / missing surface file → partial result, not a crash; no data in window → friendly empty, not an error.

## 10. Phased implementation

>3 files; decompose in the plan:

1. **Sink substrate:** schema v3 + `migrate()` v2→v3 + **column-detect prepared-statement fallback** in `openSink` (`PRAGMA table_info` → v3 insert iff `session_id` present, else legacy 12-col insert; `StatsSink` records the shape) + `StatsEvent`/`writeEvent` conditional `session_id`. Unit-tested (fresh v3; v2→v3 idempotent; NULL default; **simulated failed ALTER → legacy insert prepared, sink still logs, no crash**).
2. **`logged()` session-id capture + `extract_session` candidate count:** (a) resolve session via `detectCurrentSession({cwd: process.cwd()})` (env-driven), nullable, best-effort, threaded through `StatsEvent`; (b) swap `extract_session`'s `NO_STATS_RESULT` → an `extractResult` returning `{ result_count: <#new candidates from the manifest> }` (existing privacy-safe column; the only existing-tool telemetry change). Unit-tested: session undetectable→NULL (mock env); `extract_session` row carries `result_count` = new-candidate count incl. re-extract-creates-nothing → 0.
3. **Backfill attribution:** `stats backfill` sets `session_id = e.name` on synthetic rows (the session id is known at synth time, `backfill.ts:51`). Unit-tested (synthetic rows carry session_id; report not inflated post-backfill).
4. **surface-events util + hook emit:** path/append/90d-prune/tolerant-read util; `surface-hook.ts` emits on `emit=true` only, session_id from the PreToolUse stdin, best-effort, never blocks. Extends existing surface-hook integration tests.
5. **Aggregation core `sessions.ts`:** the metric definitions in §6 (coarse surface→get; `extract = extract_session`). Unit-tested per metric incl. `(unattributed)`, malformed-line skip, empty.
6. **CLI `stats sessions`** + `cli.ts` wiring. Text + `--json` tested.
7. **TUI `[ Sessions ]` panel** + tab wiring. Render-tested (vitest + ink, like `useStatsTick.test.tsx`).
8. **Docs:** README Privacy + KNOWN_LIMITATIONS "No public adoption telemetry yet" / "no aggregator" → resolved; high-level-plan Phase 11 status.

## 11. Testing

- **Unit:** migration v2→v3 (idempotent, NULL default, failure-degrades via column-detect → legacy insert, sink still logs); `writeEvent`/`logged()` session-id incl. undetectable→NULL; `extract_session` emits `result_count` = new-candidate count (and 0 when re-extract creates nothing); surface emit (line shape, emit=true-only, no-throw on fs failure, never blocks); `sessions.ts` (recall→get strict-after rule, `memoryUsed` definition, coarse surface→get, extract→cleanup = Σcleanup ÷ Σextract_session.result_count over window, `(unattributed)` bucket, malformed-line skip, empty/no-data, `unattributedShare`); backfill synthetic rows carry `session_id`; CLI text + `--json`; TUI panel render.
- **Integration:** seed `tool_calls` (+session_id, +NULL rows) and surface-events for synthetic sessions → `loadSessionAdoption` → assert rollup; CLI e2e.
- **Regression:** existing stats / TUI / MCP suites stay green — the new column is additive and nullable; existing queries unaffected.

## 12. Open items

- **surface→get is coarse in v1, definitively** (not an open question): the current stats contract records no get target id (`NO_STATS_RESULT`, `meta:null`, no id field). Precise id-exact correlation is a deferred follow-up requiring a privacy-reviewed `memory_id`/`meta` stats field + `get_memory` `extractResult` — explicitly out of v1 scope.
- **Session-id resolution coverage** is harness-dependent (some expose it only to hooks, not MCP processes). `unattributedShare` makes this visible rather than silently skewing the headline; if coverage is poor in practice, a follow-up can have the SessionStart hook persist a per-session marker the MCP process reads (out of scope here).
- **extract→cleanup** is window/project-level and **approximate** by construction: even with `extract_session.result_count` (new-candidate count) as the denominator, cleanup actions and the candidates they target may fall in different windows and cohorts aren't tracked. It is a rate, not an exact cohort conversion — §6 states this so it isn't over-read. Exact cohort tracking (tag each cleanup to the extract run that produced its candidate) is a deferred follow-up, not v1.
