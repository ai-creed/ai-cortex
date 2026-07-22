# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Unreleased

---

## v0.17.0 (2026-07-22)

This release ships the intake gate v2: session-extraction captures are now tier-routed at intake, so zero-signal noise is born straight into the reviewable trash instead of piling up as candidates, and the dormant aging sweep is switched on. This targets the ~90% junk rate and the diverging candidate backlog measured in the 2026-07-21 corpus re-audit.

### Added
- **Tier-routed intake.** Every extracted capture is scored by the existing signal heuristics at capture time; zero-signal captures are created directly in trash (reason `intake: zero-signal capture`) with no embedding work, full provenance preserved, and a 90-day restore window. High-signal captures land as candidates exactly as before. Controlled by the `intakeTierRouting` config flag (on by default).
- **Automatic aging sweep.** After each session briefing, aged candidates are swept to trash at most once per 24 hours (`aging.autoSweep` config). Note: the first briefing after this release triggers the first sweep wave over the accumulated backlog — swept items are restorable for 90 days.
- **Worktree ignore list.** Sessions whose worktree path matches `ignoreWorktreePrefixes` (e.g. throwaway smoke-test workspaces) are skipped by extraction, and session records now persist their worktree path to make this enforceable.
- **Replay release gate.** A committed, labeled capture corpus plus replay harness (`scripts/harvest-intake-corpus.ts`, `scripts/replay-intake.ts`, replay-gate test suite) enforces zero known-gem loss and ≥80% noise suppression before the gate's heuristics can change.

### Changed
- **`untrash_memory` is type-aware.** Restoring a trashed capture returns it to `candidate` (the review queue) instead of promoting it to `active`; non-capture types restore to active as before.
- **Extraction manifest reports routing.** `extract_session` results now include discarded-capture counts and titles alongside created candidates, so intake decisions stay visible.

## v0.16.1 (2026-06-27)

This release teaches edit-time memory surfacing to stop re-suggesting memories you keep ignoring, and tightens fallback tag matching so fewer off-topic memories surface while you edit. Recall is unchanged — only the automatic edit-time surfacing is affected.

### Added
- **Dismissal-aware edit-time surfacing.** When a memory is repeatedly surfaced for a file but never consulted, ai-cortex learns to stop surfacing that (memory, file) pairing while editing. Dismissals are inferred implicitly from surfacing telemetry — no new tool or manual step — and reconciled incrementally with a version-aware watermark, so editing a memory re-arms its surfacing. `recall_memory` and `get_memory` are never suppressed.
- **Per-session surface dedup.** Within a session, a memory already shown for a given file is not shown again on subsequent edits to that same file.

### Changed
- **Tighter Tier-2 tag matching.** Generic, high-frequency tags are excluded from the fallback tag-overlap score and a minimum overlap is now required, so broadly-tagged memories no longer surface on weak, incidental matches.

---

## v0.16.0 (2026-06-24)

This release adds the cross-project document library: an opt-in, cache-only retrieval layer that indexes documentation across all of your projects and returns cited passages, ranked current-project-first. It is fully separate from the memory store.

### Added
- **Cross-project document library.** Register any directory as a source and search cited passages across every project from one place. Every result carries full provenance (source, file, line range, heading path) and documents from the current project rank first.
- **`cortex library` CLI.** New `register`, `list`, `reindex`, `search`, and `metrics` subcommands.
- **Four MCP tools.** `library_search`, `library_register_source`, `library_list_sources`, and `library_reindex`, so agents can register sources and retrieve cited passages over MCP.
- **Hybrid retrieval.** Lexical full-text search (FTS5) and semantic vector search are fused with reciprocal rank fusion, reranked for origin affinity and document value, and flagged for freshness. Search falls back to lexical-only when the embedder is unavailable.
- **Incremental, model-aware indexing.** The indexer skips unchanged files by content hash and mtime, relinks moved content, stores resident vectors scanned with a bounded top-K heap (no whole-matrix load), and recovers from corrupt or locked indexes. A registered source whose root disappears is marked errored and skipped, never crashing search.
- **Opt-in and cache-only.** Nothing is indexed until you register a source, and all index state lives under `~/.cache/ai-cortex/v1/library/`. The library never writes into a source repository.
- **Utility instrumentation.** Library searches record visibility and a downstream-touch proxy so usefulness can be measured, never gated on whether a result is consulted.

### Security
- **Patched dependency advisories.** Updated `protobufjs`, `vite`, `hono`, `qs`, `ip-address`, `postcss`, `esbuild`, `fast-uri`, and `vitest` via pnpm overrides.

---

## v0.15.1 (2026-06-10)

This patch release makes the memory-capture queue practical to audit. The extractor still errs on the side of preserving potentially useful rules, but obvious low-signal captures no longer crowd the default review surfaces, and stale low-signal captures age out safely.

### Added
- **Tier-aware capture review.** `review_pending_captures` now returns high-signal captures by default, includes each capture's tier, and accepts `includeLowSignal` when you intentionally want to audit the hidden tail.
- **Expanded memory taxonomy.** The built-in registry now includes `constraint`, `preference`, and `deferred`, giving agents clearer choices when rewriting captured memories into durable rules.

### Changed
- **Briefings now separate capture cleanup from generic memory cleanup.** High-signal captures get their own action nudge, low-signal counts are disclosed separately, and `list_memories_pending_rewrite` no longer double-surfaces raw captures.
- **Low-signal captures auto-expire.** Untouched low-signal capture candidates are trashed after 14 days, while high-signal captures keep the existing candidate aging behavior.
- **Gotcha recording is easier.** CLI and MCP memory writes now default missing `gotcha.severity` to `warning` at the tool layer.

### Fixed
- **Capture gating rejects more mechanical noise.** Resume prompts, interrupted requests, screenshot-only paths, structured blobs, workflow handoff boilerplate, and multiline error-log blobs are filtered before they become candidate memories.
- **Aging sweep is drift-safe.** A missing or drifted memory file no longer aborts the whole sweep; the sweep skips the bad row and continues.

### Internal
- **Capture precision is covered by a labeled corpus.** The new regression fixture preserves all 11 audited keepers, suppresses 110 of 128 audited noise captures, and holds the triage ratio at about 2.6:1.
- **Extraction-to-briefing integration is covered.** A real transcript fixture now verifies that extracted captures land in the tier-aware briefing flow and stay out of the generic pending-review queue.

---

## v0.15.0 (2026-06-10)

### Added
- `capture_session` MCP tool: host-agnostic session capture. Any host that
  writes a Claude-format transcript JSONL can call it to run the capture
  pipeline (parse, evidence, chunks, extractor) against the history cache,
  deriving repo identity from `worktreePath`. Also adds a projection-evidence
  round-trip.

### Fixed
- History capture no longer re-embeds the whole session on every capture. It
  reuses vectors for chunks whose text is unchanged and embeds only new or
  changed chunks. On the Codex hook path (capture fires every turn) this drops
  per-session capture from an O(n^2) embedding cost, with a model round-trip
  each turn, to O(new chunks).
- History capture now detects in-place edits and shrinks of a transcript via a
  content hash over turn text and tool uses, instead of keying only on turn
  number. Such changes were previously skipped as up-to-date, leaving stale
  chunks and vectors on disk. Memory extraction reads these records, so this
  keeps extracted memory in sync with the real transcript.

---

## v0.14.2 (2026-06-08)

### Fixed
- Bump `better-sqlite3` to `^12` (12.10.0) so global install works on Node 26.
  The pinned 11.x shipped no prebuilt binary for Node 26 and failed to compile
  from source against its V8 (removed `Object::GetPrototype`,
  `Context::GetIsolate`, and `PropertyCallbackInfo::This`). 12.x supports Node
  20/22/23/24/25/26.

---

## v0.14.1 (2026-06-05)

### Added
- `cortex graph`: a "functions" toggle for the single-project code view. Large
  repos (thousands of files) produced tens of thousands of function nodes and
  bogged the viewer down, so function nodes now auto-hide once a project exceeds
  ~3500 total nodes (files + functions), leaving the files-and-imports graph
  responsive. A checkbox brings them back on demand, with a "may be slow" hint
  when the hidden set is very large. `?symbols=1|0` forces it server-side.
- `cortex graph`: an on-screen stats readout (node counts and a live FPS gauge),
  so you can see how much is rendered and how smoothly. The FPS color-codes from
  green to red as the scene gets heavier.

---

## v0.14.0 (2026-06-05)

### Added
- `cortex graph`: an interactive, terminal-styled 3D viewer of your memories and
  indexed codebases, served read-only in the browser from `~/.cache/ai-cortex`
  (it never touches the target repo). Two views over one canvas:
  - Code (the default): a static "brain graph" of a project's files, imports,
    and calls, colored by module, with a blast-radius highlight (click a file to
    see what a change would affect) and a clickable legend to show/hide modules.
  - Memory: a force-directed galaxy of memories across all cached projects,
    encoded by category (color and shape), importance (size), and confidence
    (brightness).
- Live ai-cortex retrieval behind the search box, demonstrating how an agent
  sees your code and knowledge. In code view, `find` matches files and functions
  by name or path, and `suggest_files` runs the real task-to-files ranking; in
  memory view, search runs `recall_memory`. Results highlight in the graph and
  list in a side panel.
- `cortex graph` flags: `--project`, `--mode`, `--flat`, `--semantic`, `--port`,
  `--no-open`, and `--export` (writes the graph as JSON instead of serving).
- `pnpm cortex:graph` dev script, which builds the web bundle before serving.

### Notes
- The graph builder is pure and store-namespaces every node id, so memories and
  files from different projects never collide on one canvas. The server is
  read-only and reads only from `~/.cache/ai-cortex`.

---

## v0.13.0 — 2026-06-04

### Added
- Per-worktree SQLite structural store, replacing the per-worktree JSON cache.
  A WAL-mode `.db` with a queryable schema (files, docs, imports, functions,
  calls, meta). Legacy `.json` caches transcode to SQLite in place on first
  read, with a reindex fallback for incompatible/corrupt caches. The `memory/`,
  `history/`, and `stats/` stores are untouched by the migration.
- v3.1 index contract: call edges carry a `site` Range and functions carry full
  ranges (`column` / `endLine` / `endColumn`); `SCHEMA_VERSION` is now `3.1`
  (additive, major-compatible — existing v3 caches stay valid). Documented in
  `docs/architecture/cortex-index-contract.md`.
- `blast_radius` runs a read-only recursive-CTE query over the SQLite store,
  avoiding whole-graph materialization on the fresh path, and returns
  `callSite` / `range` location data on each hit and the target.

### Changed
- Dashboard worktree discovery (`cacheMeta`) keys off `.meta.json` sidecars and
  `.db` files instead of the old `.json` manifest.
- Failed tool calls now record the error message and code in stats (the `meta`
  column), so the *why* of a failure is queryable instead of just its class.
- `record_memory` / `rewrite_memory` tool docs surface the registered memory
  types (`decision`, `gotcha`, `pattern`, `how-to`, plus project-custom) and
  `gotcha`'s required `severity` upfront.

### Fixed
- `search_memories` no longer throws `SqliteError` on queries containing
  FTS5-special characters (unbalanced quotes, `*`, `AND`/`OR`/`NEAR`, parens).

## v0.12.1 — 2026-05-28

### Changed
- `cortex stats` overview now renders two verdict bands: one for "all
  projects" (the v0.12.0 behavior) and a second for the currently-
  selected project so per-workspace signal isn't drowned by the
  cross-project average. The `Effectiveness` / `Activity` / `Memory`
  panels follow the selected project too; `Storage` stays aggregate
  (top-N is more useful that way).

### Fixed
- When opened on an empty cache (no workspaces yet), the dashboard
  cleanly hides the per-project verdict band instead of rendering a
  blank row.

---

## v0.12.0 — 2026-05-28

Self-explaining stats dashboard and TUI-driven workspace hygiene. The
overview now leads with a plain-language verdict ("Is ai-cortex
helping?") backed by a new aggregate adoption reader, and junk
workspaces from test/smoke runs can be excluded, archived, or cleaned
directly from `cortex stats`.

### Added
- `cortex stats` overview leads with a verdict band synthesizing
  `memoryUsed%`, `recall→get`, and `err%` into a plain-language helping /
  mixed / too-little-data verdict (`src/lib/stats/verdict.ts` is the
  single source of truth for thresholds and phrase priority).
- `[?]` help overlay explains every metric with its good/ok/bad
  thresholds, sharing constants with the verdict synthesizer and panel
  colors so the dashboard can never drift from its own legend.
- `Effectiveness` is a first-class panel on the overview (memory used,
  recall→get, suggest hit), backed by a new `adoptionAcross` reader and
  `suggestHitCounts` aggregate.
- Workspace hygiene from the TUI: `e` exclude, `a` archive, `x` clean
  on the selected project. Only `x` prompts y/n; `assertRepoKey`
  validates every path before any filesystem op. Exclusions live in
  `~/.cache/ai-cortex/v1/stats-config.json`; archived caches move under
  `~/.cache/ai-cortex/v1/_archived/<repoKey>/`.

### Changed
- Detail panel default tab is now `Effectiveness`; tabs reordered to
  `Effectiveness · Tools · Memory · Suggest · Storage`. Numeric keys
  `1-5` follow the new order.
- Overview grid is `Effectiveness / Activity` over `Memory / Storage`;
  the cache-mix panel moves into the help overlay (still on the
  per-project Tools tab).
- `KeyBar` advertises `j/k` nav, `Tab`, `w`, and `?help`, plus a
  context-aware hygiene hint line for the selected project.
- `listProjects()` honors `stats-config.json` exclusions in addition to
  the existing underscore-prefix filter for the archive subtree.

## v0.11.1 — 2026-05-25

Codex edit-time memory surfacing. The `PreToolUse` surface hook — previously Claude-only — now installs for Codex too. The v0.9.1 §13 "Codex doesn't fire `PreToolUse`" gate turned out to be a misdiagnosis of Codex's hook-trust requirement rather than an upstream defect; re-verified on codex-cli 0.133.0, `PreToolUse` fires for `apply_patch` once the hook is trusted via `/hooks`, and the captured payload confirms the patch body arrives at `tool_input.command` exactly as the parser assumed.

### Added

- **Codex `PreToolUse` surface hook** in `src/lib/history/hooks-install.ts` — `ai-cortex hooks install` now writes a `[[hooks.PreToolUse]]` block with `matcher = "apply_patch"` (the alias every Codex file edit reports), at the same 10s timeout as the Claude hook. Idempotent install/uninstall, keyed on the existing `ai-cortex memory surface-hook` marker so user-authored Codex hooks are preserved.
- **`/hooks` trust reminder** printed after any Codex hook write — Codex skips non-managed hooks until trusted, and trust is pinned to the hook's hash, so an upgrade that changes the definition requires re-trusting.

### Fixed

- **`permissionDecision` is now Claude-only** in `src/lib/memory/cli/surface-hook.ts`. Codex rejects the field (`unsupported permissionDecision:allow`) and fails the hook, which would have fired on every Codex `apply_patch`. The field is now emitted only for positively-identified Claude edit tools (`Edit`/`Write`/`MultiEdit`); Codex and all unknown/error paths omit it. Absence means "proceed normally" on both harnesses, so an edit is never blocked.

### Known limitations

- **Codex edit-time surfacing requires hook trust and has narrower coverage than Claude.** Re-verified on codex-cli 0.133.0: `PreToolUse` fires for `apply_patch`, but Codex skips non-managed hooks until they are trusted in `/hooks`, and trust is pinned to the hook's hash (so an ai-cortex upgrade that changes the hook requires re-trusting). Interception covers `apply_patch` and simple `Bash`/MCP calls, not the newer `unified_exec` shell path or non-shell, non-MCP tools. Supersedes the v0.11.0 "Codex install path deferred" limitation.

---

## v0.11.0 — 2026-05-24

Track B — tag-aware memory surfacing. Track A (legacy-scope self-heal, 2026-05-23) closed the gap where memories with stranded scope went unseen; Track B closes the next gap, where memories that are correctly tag-scoped but have no file scope go unseen too. Real-world cost in the 2026-05-21 postmortem: five raw `git commit --no-verify` calls in one session while `favro-commit-auto` sat unreached. The PreToolUse `surface-hook` learns a Tier 2 fallback that admits tag-only and mixed-scope memories when Tier 1 returns fewer than the cap; a new SessionStart hook emits a curated workflow-rules listing on every session boundary (startup, resume, clear, compact) for the cross-cutting rules that don't tie to a specific file. Ships Claude-only — the Codex install path remains deferred pending empirical verification of Codex's `apply_patch`-side PreToolUse delivery (per v0.9.1 §13 historical record).

### Added

- **Tier 2 tag-overlap fallback in `matchSurfaceMemories`** — opt-in via a new `{ tier2: true }` parameter. Fires only when Tier 1 file-scope match returns fewer than `CAP` hits. Tier 2 scores each candidate via normalized-token overlap between the file path and the memory's `scope.tags` (lowercase, split on `[-_./\s]+`, basic plural strip in `src/lib/memory/tag-overlap.ts`; popular-tag set as +1 tiebreaker, cached on `RetrieveHandle`). Mixed-scope memories whose `scope.files` does not match this path fall through to Tier 2 via tags. Tier 1 always ranks above Tier 2; no memory double-counts. `suggest_files*` `relatedMemories` path explicitly does NOT opt in — the 2026-05-06 Non-goal is preserved.
- **`CAP` bumped 3 → 5** in `src/lib/memory/surface-core.ts` — gives Tier 2 room without crowding out Tier 1 hits. The dedup ledger (per-file, per-session) and the "surfaced ≠ relevant" footer continue to bound noise.
- **`SurfacePointer.tier`** — optional `"file" | "tag"` label exposing which tier sourced each pointer. Surfaces in telemetry; no impact on call-site consumers that ignore it.
- **SessionStart workflow-rules surface** — new CLI `ai-cortex memory list-workflow-rules` (`text` / `json` / `hook` formats) and Claude Code SessionStart hook (matcher `startup|resume|clear|compact`, command `ai-cortex memory list-workflow-rules --format=hook`, 10s timeout). Filters to active, tag-only (no file scope), `decision` / `how-to` memories; sorts pinned-first → `getCount` desc → recency; capped at 10 (`AI_CORTEX_WORKFLOW_LIST_CAP` configurable).
- **`rehydrate_project` workflow-rules fallback** — when no SessionStart hook is installed (detected by `sessionStartWorkflowHookInstalled()` reading the canonical hook config), `rehydrateRepo`'s briefing appends the same workflow-rules section as a backup surface. Detection is fail-open: read errors include the section rather than risk hiding it. Renders via the same `briefing-workflow-rules.ts` helper the CLI uses — single source of truth.

### Changed

- **Claude Code PreToolUse hook timeout bumped 5s → 10s** in `applySurfaceInstall` — cushion for cold-start SQLite open and IO contention, since Tier 2 adds a candidate scan over the project's tag-only memories. The internal `DEADLINE_MS = 250` soft deadline in `surface-hook.ts` remains the real gate; 10s is harness headroom.
- **`surface-events` telemetry** — events gain an optional `tiers: ("file" | "tag")[]` array parallel to `memoryIds`. Each element labels the tier the same-index memory came from, so mixed Tier 1 + Tier 2 events are representable. Existing readers ignoring the field are unaffected.
- **`hooksMigrationStatus()` recognizes the new install shape** — settings with the old `timeout: 5` or without the new SessionStart entries report `needsInstall: true`, surfacing the same v0.10.3 briefing nudge until the user re-runs `ai-cortex history install-hooks`.

### Internal

- **`src/lib/memory/tag-overlap.ts`** (new) — pure normalization + scoring primitives. `stripBasicPlural` handles `-ies → -y`, sibilant `-ses` / `-xes` / `-ches` / `-shes`, and plain `-s` (preserving `-ss` so `less` stays `less` and `class` stays `class`).
- **`src/lib/memory/workflow-rules.ts`** (new) — pure selection (`selectWorkflowRules`) + text formatter (`formatWorkflowRulesText`).
- **`src/lib/memory/briefing-workflow-rules.ts`** (new) — repo-keyed briefing extra following the `briefing-pinned.ts` / `briefing-digest.ts` pattern; consumed by `rehydrateRepo` and gated on install state.
- **`src/lib/memory/cli/list-workflow-rules.ts`** (new) — CLI entrypoint exposed via `ai-cortex memory list-workflow-rules`.
- **`applyWorkflowRulesInstall` / `applyWorkflowRulesUninstall`** in `hooks-install.ts` — pure functional install/uninstall of the Claude SessionStart entry, composed into `installHooks` and `uninstallHooks` via the existing `applyXxxInstall` chain.

### Known limitations

- **Codex install path deferred.** The Codex side of the install (PreToolUse on `apply_patch` and SessionStart) was historically gated off per v0.9.1's §13 (Codex 0.130.x didn't fire `PreToolUse` for `apply_patch`/`Bash`). Track B ships Claude-only until empirical verification on a current Codex CLI release confirms `PreToolUse` payload delivery — re-test and re-enable when verified.
- **Tag synonym misses.** Track B's tag overlap matches normalized tokens only; true synonyms (`git` ≈ `repo`, `e2e` ≈ `end-to-end`) won't match. v1 accepts these misses; revisit with an embedding fallback or per-project synonym map if telemetry shows the miss rate matters.
- **Cross-tier (global store) surfacing** stays project-tier only, matching Tier 1's existing scope. A future track may extend either prong via the `recallMemoryCrossTier` pattern.

---

(Track A — legacy-scope self-heal, shipped 2026-05-23: `reconcileStore` self-heals active memories whose scope is stranded in an inline terminal body trailer. Trailer is parsed (strict JSON-array when payload looks like JSON, comma-fallback for plain text), merged into canonical frontmatter only when frontmatter scope is empty, body is stripped, file is rewritten via the atomic write path, and the audit row records reason `legacy scope normalized`. Mid-body tag mentions are preserved. Trashed files are not repaired.)

---

## v0.10.4 — 2026-05-21

Security patch. The embedding stack (`@xenova/transformers` → `onnxruntime-web` → `onnx-proto`) pulled `protobufjs@6.11.5` transitively, which is exposed to **CVE-2026-41242** — arbitrary code execution through crafted protobuf "type" fields during decode, CVSS 9.8 — plus eight related HIGH/MODERATE advisories (CVE-2026-44288 through 44294, CVE-2026-45740). No direct usage and no source imports of protobufjs; the exposure is purely the bundled dependency version.

### Fixed

- **`pnpm.overrides` pin** in `package.json` — targeted `"protobufjs@<7.5.5": "^7.5.5"` rewrites only the vulnerable range, leaving the resolver free elsewhere. Resolves to `protobufjs@7.6.0`, which clears every advisory in the chain: the `^7.5.5` floor covers both the critical fix (7.5.5) and the slightly newer 7.5.6 fix for CVE-2026-44293, and the `<8.0.0` ceiling avoids the also-vulnerable 8.0.0 line. OSV recheck on 7.6.0 returns zero advisories.

### Internal

- Verified the v6→v7 major bump against the ONNX path: typecheck clean, full unit suite (1425 tests) green, and the env-gated semantic integration suite (`AI_CORTEX_SEMANTIC_INTEGRATION=1`, real ~23 MB model load through `@xenova/transformers`) passes — confirming protobufjs 7 parses ONNX schemas without regression.

---

## v0.10.3 — 2026-05-20

The hook-configuration migration notice. Existing users on v0.9.0+ who never re-ran `ai-cortex history install-hooks` after upgrading have features that depend on later-introduced hooks sitting silently inert. v0.10.3 surfaces a one-line nudge in the MCP rehydrate briefing whenever their `~/.claude/settings.json` or `~/.codex/config.toml` diverge from what the installer would write today — built on top of the v0.10.2 notice infrastructure so it composes cleanly with the update notice.

### Added

- **`hooksMigrationStatus()`** in `src/lib/history/hooks-install.ts` — pure read-only check. Reuses the existing `applyInstall` + `applySurfaceInstall` + `applyCodexInstall` pipeline to compute the post-install state and compare against current files. Returns `{ needsInstall: true }` defensively on parse failure — better to surface a notice than silently miss a real migration. No writes; no prompts.
- **`src/lib/migration-notifier.ts`** with `getHookMigrationNotice()` — mirrors `update-notifier`'s shape: env gate (`AI_CORTEX_NO_UPDATE_CHECK` honored for symmetry with the update nudge), top-level try/catch so a briefing render can never crash on its behalf, plain-text MCP-surface output. Wording is **neutral on tool-specific behavior** — Codex 0.130.x doesn't fire `PreToolUse` for `apply_patch`/`Bash` regardless of install state, so claiming "Edit/Write surface won't fire" would be wrong on Codex. The notice points users at `ai-cortex history install-hooks`, which surfaces the exact diff before applying.
- **Notice composition in `rehydrate_project` handler** — both notice helpers (`getBriefingNotice` + `getHookMigrationNotice`) called under independent try/catch blocks; non-null results join with a blank line and pass through `rehydrateRepo({ notice })`. When both are null, the briefing renders exactly as before.

### Internal

- 6 unit tests on `hooksMigrationStatus` covering absent files, partial install (pre-v0.9.0 case), codex-only divergence, malformed JSON, and pure-read confirmation; 5 on `getHookMigrationNotice`; 4 new server-handler tests asserting composition and defense-in-depth.

---

## v0.10.2 — 2026-05-20

The update-notification aggression release. The MCP `rehydrate_project` briefing now surfaces an upgrade nudge with tier-aware loudness and a one-line "what's new" headline sourced from a new custom `aiCortex.releaseHeadline` package.json field. ai-cortex has ~2k npm downloads and most users only run `ai-cortex mcp` (long-lived) — the existing CLI-side update notifier never fires for them, so a meaningful fraction of users are likely several releases behind without knowing it. v0.10.2 routes that signal through the briefing surface where the agent naturally relays it. (v0.10.1 was a burned tag — failing CI on this same feature work; never published. v0.10.2 reships with the test fix.)

### Added

- **Severity tiers (`compareSeverity`, `Severity` union)** — `"none" | "patch" | "minor" | "multi-minor"`. Pre-release suffixes ignored for comparison. Drives loudness: patch is once-per-UTC-day throttled and subtle; minor is a two-line block; multi-minor adds an `N minor releases behind` / `major version behind` callout. Each tier × surface combination is unit-tested.
- **Tier-aware `formatNotice({ current, latest, headline, tier, surface })`** — replaces the prior 2-arg form. `surface: "cli"` may include ANSI bold on minor / multi-minor; `surface: "mcp"` is always plain text (the agent's relay must be readable). Empty headline collapses to the no-em-dash fallback (`ai-cortex 0.10.1 available. Run: ...`) — no `available — .` punctuation artifact.
- **MCP-side `getBriefingNotice({ currentVersion })`** — honors `AI_CORTEX_NO_UPDATE_CHECK`; triggers `spawnBackgroundFetch()` on stale/absent cache (same as `checkForUpdate`); applies the tier throttle; on patch-tier emit, performs read-modify-write of `lastBriefingShownAt` only (leaves the other three cache fields untouched). Wrapped in a top-level try/catch — must never crash a briefing.
- **`renderBriefing(cache, opts?: { notice? })`** — new optional second arg in `src/lib/briefing.ts`. When `notice` is non-empty after trimming, prepended with a blank line above the existing header. When absent / null / empty / whitespace, output is byte-identical to baseline (regression-guarded).
- **`RehydrateOptions.notice`** — forwarded into `renderBriefing` _before_ `fs.writeFileSync(briefingPath, ...)` so the persisted briefing file (which the MCP handler reads back at line 440) carries the notice.
- **`src/mcp/server.ts` rehydrate_project handler** — calls `getBriefingNotice({ currentVersion: SERVER_VERSION })` and passes the result via `rehydrateRepo({ notice })`. Uses `SERVER_VERSION` (already imported as `VERSION` from `src/version.ts`) — **does not read `package.json` at runtime** (the dist-vs-tests path math diverges, per the existing comment in `src/cli.ts:23-30`).
- **`aiCortex.releaseHeadline` manifest field** — npm preserves arbitrary top-level package.json fields in the per-version manifest, so the existing `/ai-cortex/latest` fetch returns the headline with no second request.
- **`scripts/lib/release-headline.ts`** (TypeScript helper, not `.mjs`) — pure JSON read-modify-write for `aiCortex.releaseHeadline`. Preserves tab indentation and trailing newline. CLI dispatch compares `fs.realpathSync(fileURLToPath(import.meta.url))` against `fs.realpathSync(process.argv[1])` so `/tmp ↔ /private/tmp` symlinks on macOS don't silently no-op the entrypoint check (same realpath issue that bit the repo-identity path earlier). Wrapped in try/catch so it behaves as a pure library if `argv[1]` is unresolvable.
- **`scripts/release.sh` headline prompt** — runs **before** any file mutation (`npm version`, `sed src/version.ts`) so a failed read leaves the working tree clean. `AI_CORTEX_RELEASE_HEADLINE` env var provides a non-interactive escape hatch (CI / unattended); without it AND without a TTY, the script exits non-zero with an explicit error rather than EOF-failing under `set -e`. Three input shapes: non-empty (new headline), bare Enter (reuse previous), literal `-` (clear). `(none)` display when the previous value was empty or literally `-` (round-trip ambiguity guard).

### Changed

- **`checkForUpdate(...)` return shape** — evolved from `string | null` to `{ latest: string; headline: string; tier: Exclude<Severity, "none"> } | null`. `printUpdateNotice` signature changed to match: `(current, info)`. `src/cli.ts` call site updated accordingly. CLI surface keeps its existing daily cache cadence and `SKIP_COMMANDS` list — notably `mcp` stays in skip, so only the briefing path emits to the MCP server's own stderr.
- **`runBackgroundFetch`** — extended to extract `aiCortex.releaseHeadline` from the manifest (default `""` on missing / wrong type). **Reads the prior cache first and preserves `lastBriefingShownAt`** as-is — the throttle key belongs to the main process, and resetting it on every 24h fetch would over-emit patch notices.
- **`CacheData`** shape — `{ checkedAt, latestVersion }` extended to `{ checkedAt, latestVersion, releaseHeadline, lastBriefingShownAt? }`. `readCache` accepts both legacy and new shapes (legacy → `releaseHeadline: ""`, `lastBriefingShownAt: undefined`). `writeCache` omits `lastBriefingShownAt` when undefined — guarded on `!== undefined`, not falsy, so a future empty-string value (if any caller wanted it) would round-trip cleanly.

### Fixed

- **`checkForUpdate` test cleared `process.stdout.isTTY` but not `process.env.CI`** — passed locally and failed under GitHub Actions, which sets `CI=true` automatically. The v0.10.1 tag was burned by exactly this. v0.10.2 saves+restores both env vars across the test. Memorized for future releases: **always run `CI=true pnpm test` before tagging** — local `pnpm test` is not equivalent to CI for env-gated code.

### Internal

- 14 task commits + 1 in-task fix (`writeCache` undefined-guard) + 1 lint cleanup. 1410 → 1422 tests under `CI=true`; lint and typecheck clean.
- `tsconfig.json` `include` extended with `scripts/**/*.ts` so the new helper is typechecked alongside the rest of the codebase. Compiled output `dist/scripts/...` is not shipped (the `files` array in package.json restricts publish to `dist/src/`).

### Known limitations (new this release)

- **Multi-version "behind on these releases:" enumeration deferred.** When `tier === "multi-minor"`, the notice today shows just the latest release's headline + the `N minor releases behind` count. Walking the full `/ai-cortex` packument to list every intervening release's headline would require a second / heavier fetch and a multi-version cache; deferred until the single-headline form proves insufficient.
- **First MCP session after install sees no notice.** Background fetch is detached and asynchronous; the first call has no cached version to compare against. The next call (typically seconds later or guaranteed in the next session) emits the notice. Matches the existing CLI nudge's first-run behavior.

---

## v0.10.1 — 2026-05-20 (burned tag, never published)

**Never published.** The `checkForUpdate` unit test introduced in the update-notification work cleared `process.stdout.isTTY` but not `process.env.CI`. The test passed locally and failed under GitHub Actions, which sets `CI=true` automatically. The `v0.10.1` tag exists on origin (`28591dc`) but the Publish workflow's `pnpm test` step blocked the npm publication — npm registry never saw a 0.10.1 tarball. Superseded by **v0.10.2** (`de16012`).

---

## v0.10.0 — 2026-05-20

The Phase 11 adoption-telemetry release. ai-cortex grows the ability to answer **"is the memory layer actually being used?"** per session, not just in aggregate. The schema gets a `session_id` column on `tool_calls`, `logged()` attributes every MCP call, edit-time surfacings get their own hot-path-safe JSONL telemetry, and a new aggregation core joins SQL + surface events into per-session adoption rows plus a window summary. Plus a CLI report, a TUI tab, and an interpretation guide — the metrics ship with their own meaning baked in so a number on screen is read the same way every time.

### Added

- **`tool_calls` schema v3 — `session_id` column** (nullable). Harness-detected from `AI_CORTEX_SESSION_ID`, `CLAUDE_SESSION_ID`, or `CODEX_THREAD_ID` (whichever is set first). Column-detect prepared-statement fallback in `openSink`: a failed migration degrades to legacy logging instead of crashing the sink.
- **`logged()` MCP middleware attributes every call** — `session_id` carried through tool invocations. `extract_session` reports candidate count as `result_count` for consistency with other readers.
- **`surface-events.jsonl`** (cache-only, hot-path-safe) — records every edit-time surfacing without a native sqlite dep, so the surface hook stays fast. Read at aggregation time only.
- **`loadSessionAdoption` aggregation core** — joins `tool_calls` + `surface-events` into per-session rows and a window summary. Exposes `memoryUsed`, `recall→get`, `surface→get`, `extract→cleanup`, and `unattributedShare` ratios. Each metric ships with an inline meaning (`↳` subtitle in the TUI; appended line in the CLI report) — no thresholds yet, just a stable read.
- **`ai-cortex stats sessions [--window 7d] [--json]`** — CLI report. `--json` for CI / scripting; default human-readable table with per-metric meanings inline.
- **Sessions adoption tab** in the stats dashboard — pure presenter fed by the central `readAll` loader; mirrors the CLI's per-metric meaning text.
- **Adoption-metrics interpretation guide** (`docs/shared/adoption-metrics.md`) — per-metric meaning, combined-read patterns, and why no ✓/✗ thresholds yet. CLI + TUI reports footer-link to this doc.

### Changed

- **Backfill attributes synthetic rows with `session_id`** — `ai-cortex stats backfill` already knew the session directory name; backfill now stamps it so running backfill doesn't inflate `(unattributed)` in the aggregation.

### Fixed

- **`loadSessionAdoption` returns a partial result (surface events only) when the stats sqlite is corrupt or unreadable** instead of propagating the error — preserves the §9 inviolable "readers never crash callers" contract.

### Documentation

- **`docs/shared/adoption-metrics.md`** — the new interpretation guide above.
- **`KNOWN_LIMITATIONS.md`** — the _Adoption telemetry_ entry is resolved.
- **§13 Claude `PreToolUse` timeout fail-open** verified empirically on CC 2.1.144 — downgraded from "open risk" to a documented gotcha (memorized).
- **Update-notification aggression design** committed (`docs/superpowers/specs/2026-05-20-update-notification-aggression-design.md`) for the next release.

---

## v0.9.1 — 2026-05-19

A targeted performance fix. The TUI stats dashboard previously parsed every full worktree cache JSON on each 1.5s tick — 80+ MB of parsing per tick on repos with multiple worktrees, producing visible CPU spikes. v0.9.1 introduces a small `*.meta.json` sidecar that the dashboard reads instead, with no migration needed.

### Fixed

- **`cacheMeta` reads a small `*.meta.json` sidecar** instead of parsing the full worktree cache JSON on each TUI dashboard tick. Removes the 80+ MB/tick parse path on multi-worktree repos.
- **`writeCache` emits the sidecar best-effort** — sidecar write failure is logged but never blocks the main JSON write.
- **Self-healing migration** — `cacheMeta` falls back to the full JSON and lazy-writes the sidecar on miss, so existing entries upgrade themselves on the first dashboard tick. No explicit migration step required.

### Documentation

- **§13 Codex `PreToolUse` non-emission** verified on `codex-cli` 0.130.0 — Codex doesn't fire `PreToolUse` for `apply_patch` or `Bash`, regardless of installation state (memorized — informs the v0.10.3 migration notice wording).
- Aligned `MEMORY_LAYER.md` and `KNOWN_LIMITATIONS.md` with the edit-time surfacing semantics introduced in v0.9.0.

---

## v0.9.0 — 2026-05-19

The edit-time memory surfacing release. ai-cortex memories now activate _before_ an edit, not after — a Claude Code `PreToolUse` hook surfaces project-scoped memories for the target file as non-blocking `additionalContext` so the agent has the rule in hand at the moment it matters. First npm release since v0.5.6: v0.6.0–v0.8.0 were tagged but never published, and their cumulative content (TUI stats dashboard, memory browser, memory capture redesign) is included here.

### Added

- **`PreToolUse` surface hook** (Claude Code) — fires before `Edit`/`Write`/`MultiEdit`. Surfaces project-scoped memories for the target file as non-blocking `additionalContext`. **Always-allow, fail-open**: a hook timeout (>5s) does not block the edit (verified on CC 2.1.144 in v0.10.0's docs work).
- **Deterministic project-tier `scopeFiles` matcher** — literal + glob, with precision-first tiering (specificity → `get_count` → recency). Never bumps usage counters; no embedding lookup. Surfaced rules are _pointers_ — the agent calls `get_memory(id)` to commit, preserving the recall→get separation.
- **`patternSpecificity` ranking primitive** — prefix-dominant; deep `**` outranks shallow globs (review fix). Pure, well-tested.
- **Per-session set-hash dedup ledger** — cache-only, no repo writes. The same memory surfaced twice in one session is dedup'd by hash of the surfaced set.
- **`install-hooks` adds a Claude `PreToolUse` hook entry** — matcher `Edit|Write|MultiEdit`, 5s timeout, under a marker independent of the history capture hook so they can be installed/uninstalled separately. (Existing users on pre-v0.9.0 installs need to re-run `install-hooks` — see v0.10.3's migration notice.)
- **Pure `apply_patch` path parser for Codex** — built + unit-tested with CRLF, spaces, and column-0 fixtures locked down by contract tests. The Codex hook install itself is **deferred** pending verification of Codex's `PreToolUse` payload shape (Codex 0.130.x doesn't fire `PreToolUse` for `apply_patch`/`Bash` — see v0.9.1's docs entry).
- **`AI_CORTEX_SURFACE=0`** escape hatch — disables the surface hook at runtime.

### Fixed

- **`confirmMemory` rejects `type: "capture"`** — enforces the v0.8.0 invariant that confirmation alone doesn't promote a capture (the agent must rewrite or deprecate first).
- **Initial extraction must not skip turn 0** — review fix to the capture extractor; the first turn of a session was being dropped from candidate consideration.

### Internal

- Cap / deadline / no-session coverage added to surface-hook tests.
- Codebase first npm release in 12 days — see the note above on v0.6.0–v0.8.0.

### Known limitations (new this release)

- **Codex `apply_patch` surface deferred.** The pure path parser ships; the Codex hook install is gated off until `PreToolUse` payload shape is verified on a Codex release that actually fires the hook for `apply_patch`. Tracked in `KNOWN_LIMITATIONS.md` §13.

---

## v0.8.0 — 2026-05-19

The memory capture redesign. The auto-extractor changes from a positive classifier (regex cues that promote text into typed memories) into a **structural noise-killer** (reject the obvious noise, type the survivors as `capture`, hand off to the agent for confirmation). The judgment moves out of the substrate and into the agent, where it can use full conversational context to decide whether a candidate is actually a rule worth keeping.

### Added

- **Reserved `capture` memory type** — provisional, registry-backed. Idempotent seed-merge migration (`REGISTRY_VERSION` 2) creates the type on first run without touching user-registered types.
- **`retypeCandidate` lifecycle primitive** — candidate-only, registry-validated, **clears `typeFields` at the type boundary** so stale legacy metadata doesn't survive the transition. Audits as a new `retype` `AuditChangeType` arm.
- **Structural reject gate** in `extract.ts` — drops obvious-noise candidates by deterministic shape (length, repetition, code-block-only, etc.). Survivors are typed as `capture` and stored unjudged. **No positive classify; no `extracted` promotion path.**
- **`signalScore`** — pure, deterministic, recomputable metric for ranking captures. Not stored on the row (it's a function of the body and evidence), so changing the formula doesn't require a migration.
- **`reviewPendingCaptures` reader + `review_pending_captures` MCP tool** — read-only surface for the agent to inspect captures awaiting confirmation. Context fallback hierarchy: evidence-by-turn → session-window → bare body.
- **Briefing `Captures pending confirmation` section** — `renderBriefing` surfaces captures awaiting agent confirmation alongside the existing memory digest, so the user sees the queue every rehydrate.
- **One-shot legacy capture triage** — sentinel-guarded migration that runs on the first rehydrate after upgrade: deprecates structural noise from pre-redesign extractions; retypes legitimate survivors to `capture`. Idempotent.

### Changed

- **`extract.ts` is a structural gate, not a classifier** — the function is shorter, faster, and more honest about what it does. Decisions about whether a candidate is _actually_ a `decision` / `gotcha` / `pattern` / `how-to` are made by the agent during confirmation, not by regex.
- **Disable confidence / `reExtractCount` promotion for `extracted` candidates** — the old promotion rewarded re-ingested boilerplate. Now: structural rejects stay dropped; survivors stay `capture` until the agent intervenes.

### Internal

- Regression corpus fixture for the structural reject gate — locks in shape decisions against future drift.

---

## v0.7.0 — 2026-05-16

v0.6.0's TUI stats dashboard gains a full memory browser (drill into individual memories, see metadata + body, navigate by status group) and **memory activity sparklines** — recorded (audit) vs used (sink) signals over time so users can see whether the memory layer is being adopted. Plus a `stats backfill` subcommand for synthesizing telemetry from session history that pre-dates the v0.6.0 sink.

### Added

- **Memory browser** (`MemoryBrowser`, `MemoryList`, `MemoryBodyView`) — status-grouped table with colored type tags, windowed viewport for large stores, scrollable body view with metadata header. Reachable from the stats Memory tab via Enter; exit returns to the project detail. Selection + body memoization + reload live in the TUI without re-querying SQL.
- **Memory activity sparklines** (`MemoryActivityStrip`) — two-series rec/used sparkline. _Recorded_ sourced from the audit log; _used_ from the stats sink. Visualizes whether memories are flowing in _and_ being consulted, not just stored.
- **Read-only memory readers** — `loadMemoryList`, `loadMemoryBody`, `memoryActivity`. No schema change, no writes, typed errors. `loadMemoryBody` is side-effect-free (tested).
- **`typeColor`** — deterministic palette with fixed hues for built-in types and a deterministic fallback for user-registered ones, so the browser stays visually stable across sessions.
- **`ai-cortex stats backfill`** — synthesizes stats rows from captured session history (pre-sink sessions). Schema v2 adds a `synthetic` column + migration; the latency-stats reader excludes synthetic rows so backfilled history doesn't pollute the p50/p95.
- **Tool-name allowlist** for ai-cortex MCP tools — keeps the stats sink focused on this project's surface, ignores foreign MCP tool calls that happen to share the same logging path.

### Changed

- **Memory tab rebuilt** with the rec/used sparklines as the headline; raw counts moved to a sub-row.
- **Tools tab** — column headers + value legend (was a flat list, hard to read).
- **Single-screen layout** — inline detail panel for the highlighted project replaces the prior two-pane navigation.
- **Color scheme** — claude-style accent + semantic colors (green for recorded, terracotta for used).

### Internal

- **Architectural test: TUI files cannot import side-effecting memory modules.** Locks in the read-only stance of the dashboard against future drift.
- `AI_CORTEX_CACHE_HOME` pinned to a session tmpdir via vitest setup; explicit cache-home handling in path-assertion / isolation-sensitive tests.
- `.worktrees/**` excluded from vitest + eslint (was tripping coverage when worktrees existed on disk).
- Stats sink is a no-op under vitest unless tests opt in via env — prevents test runs from corrupting real telemetry.
- Lint sweep across pre-existing files + branch-new code.

---

## v0.6.0 — 2026-05-15

The first interactive way to inspect how ai-cortex actually performs in your projects — an Ink-based TUI dashboard that surfaces per-call latency, cache hit rates, memory health, and storage footprint across projects, fed by a lightweight per-repo telemetry sink wired through the `logged()` MCP middleware.

### Added

- **`ai-cortex stats`** — boots an Ink TUI dashboard. Components: `Overview` (project list + aggregate widgets), `ProjectDetail` (Tools / Memory / Suggest / Storage tabs), `Sparkline` (unicode-block bars), `TopList` (column-aligned label/value rows), `KeyBar` (footer hint strip), `WindowPicker` (1–4 hotkeys for 1d / 7d / 30d / 90d windows), `App` shell with polling + focus state + min-size guard.
- **`useStatsTick` hook** with backpressure — drops ticks while a previous load is in flight, so a slow read doesn't pile up renders.
- **Per-repo stats sink** — `events.sqlite` under `~/.cache/ai-cortex/v1/<repoKey>/stats/`, schema v1 with prepared inserts. Sink registry reuses handles; prune rows older than 90d on open; err-class sanitizer with a safe-tag charset to avoid PII leakage.
- **`logged()` MCP middleware extended with stats sink hooks** — every tool call records `tool`, `repoKey`, `durationMs`, `cacheStatus`, `result_count`, `errClass` (sanitized). All existing MCP call sites migrated.
- **Stats readers** (read-only, never write): `aggregate(window)` (p50/p95, cache mix), `topTools` + `latencyPerTool`, `memoryHealth` (from the existing memory index — no new sink), `storageFootprint` (10s in-process cache), `listProjects` across the v1 cache root, `cacheMeta(repoKey)` from the existing worktree JSON.
- **Cross-project aggregate** — `memoryHealthAcross`, `toolCounts` summed across projects so the Overview screen has a single coherent picture.

### Changed

- **`logged()` signature** — extended from 3 to 6 args. External consumers using `logged()` directly must update their call sites. **Internal-only breaking change** (no public API consumer known).

### Internal

- New deps: `ink`, `ink-spinner`, `react`. `.tsx` + JSX enabled in `tsconfig.json`.
- Integration smoke test for the `ai-cortex stats` CLI subcommand.

### Known limitations (new this release)

- **`recall→get` ratio definition.** v1 ships the call-count form: ratio = `count(get_memory) / count(recall_memory)` per session. This intentionally trades fidelity for clarity — a more rigorous "did this recall lead to a `get` on the same memory id within N turns" form is deferred until adoption data tells us the simpler form misleads. (Phase 11 telemetry in v0.10.0 builds on top of this same call-count form.)

---

## [0.5.6] — 2026-05-07

### Tests

- **Hermetic embed-provider mock at suite level.** Wires a default `vi.mock` of `src/lib/embed-provider.js` via `vitest.config.ts` `setupFiles`, replacing the real `Xenova/all-MiniLM-L6-v2` download with a deterministic char-trigram-hash embedder. v0.5.5's publish CI flaked on a HuggingFace CDN hiccup that corrupted the model file; the WASM fallback then hit a Node worker URL incompatibility. The new mock removes network from the test suite entirely. Per-file `vi.mock` (e.g. surface.test.ts) overrides where finer control is needed; `embed-provider.test.ts` `vi.unmock`s to exercise the real provider against its own `@xenova/transformers` mock. Two tests with real-model-calibrated cosine thresholds adjusted to the mock's scale; `producePatternCandidates` gained an opts-level `patternCosine` override (production default 0.7 unchanged).

---

## [0.5.5] — 2026-05-07

### Added

- **`suggest_files*` MCP tools surface relevant memories.** When the file ranker is high-confidence and the project (or global) memory store contains rules whose scope matches the suggested files and whose body matches the task semantically, the response includes a `relatedMemories` array of pointers (`{ id, title, track, scope, matchScores }`). The agent calls `get_memory(id)` to commit to applying a rule — surfacing alone does not bump usage counters, preserving the recall→get separation. Two-track gating: scoped memories (with `scopeFiles`) require file-overlap × task-match; unscoped memories pass a stricter task-match threshold alone. Cross-tier merge: project-tier rules outrank global-tier on equal task-match via an internal sort key (wire-visible `matchScores.task` stays as the raw cosine ∈ [0, 1]).

- **Glob patterns in memory `scopeFiles`.** Patterns like `MainApp/**/*card*` now match real paths in `recall_memory` and the new surfacing path. Previously the literal-only SQL pre-filter and scoring check silently rejected them. The fix spans both pipeline stages — broadened `filterCandidates` SQL admits any `s.value` containing `[`, `]`, `*`, `?`, or `{`; the post-fetch scoring uses the new `scope-match` utility (`matchesScope` and `createMatchCache`) to refine. Path normalization (`\\` → `/`, strip leading `./` or `/`) applies to both inputs, so Windows-style paths interoperate.

- **`src/lib/memory/scope-match.ts`** — new utility module. Stateless `matchesScope(pattern, path)` for one-offs; `createMatchCache()` returns a memoized matcher for hot paths.

- **`src/lib/memory/surface.ts`** — new module. `matchMemories(rh, opts)` per-store matcher; `matchMemoriesCrossTier(projectRh, globalRh, opts)` cross-tier wrapper mirroring `recallMemoryCrossTier`.

### Changed

- **`CandidateRow` (in `src/lib/memory/retrieve.ts`) gained a `getCount: number` field**, projected from the `memories.get_count` column. Used by `surface.ts` for a getCount tiebreak in result ordering. Pure additive — existing callers ignore the new field.

- **MCP `suggest_files*` tool descriptions** include a clause directing the agent to call `get_memory(id)` on any surfaced rule it intends to apply.

### Dependencies

- Added direct dep `picomatch` and dev dep `@types/picomatch` (~30 KB bundle impact). Used by `scope-match.ts`.

### Spec / design docs

- `docs/superpowers/specs/2026-05-06-memory-surfacing-on-suggest-design.md` — design spec.

---

## [0.5.2] — 2026-05-03

Docs + adoption patch. Restores a Claude-Code-specific limitation note that was dropped during the README → KNOWN_LIMITATIONS extraction in 4c39c99, and teaches the prompt-guide block to preload tool schemas so memory rules become actionable from turn one.

### Docs

- **KNOWN_LIMITATIONS.md** — restored the "Claude Code: tool schemas are deferred-loaded" sub-bullet under "MCP tool discovery is best-effort". Frames the failure mode (out-of-sight = out-of-mind: agent forgets `record_memory` exists because its description isn't in context until `ToolSearch` fetches it) and provides a copy-pasteable SessionStart hook that preloads structural + memory schemas and biases the agent to ai-cortex over `ls`/`grep`/`rg`. Notes explicitly that the hook is **not** installed by `ai-cortex history install-hooks` — the deferred-loading is a Claude Code harness behavior, the nudge is user-side configuration.

### Changed

- **`install-prompt-guide` block bumped v1 → v2** (`src/lib/memory/prompt-guide.ts`). Adds a "Load schemas first (Claude Code)" preamble with the exact `ToolSearch` query for the five memory tools (`recall_memory`, `get_memory`, `record_memory`, `deprecate_memory`, `confirm_memory`). Existing v1 blocks are replaced in-place via the versioned `<!-- ai-cortex:memory-rule:start vN -->` markers, so re-running `ai-cortex memory install-prompt-guide` upgrades cleanly.

---

## [0.5.1] — 2026-05-02

Patch release tightening the auto-extractor, plugging a benchmark-test data-loss bug, and aligning MANUAL.md with the actual project surface.

### Fixed

- **Auto-extractor noise** — skill bodies, slash-command output templates, system reminders, and shell I/O wrappers were being captured as user prompts because their text hits `IMPERATIVE_RE` / `SYMPTOM_RE` on words like "must"/"should"/"errors". Added `isHarnessInjection(text)` predicate matching known harness markers (`Base directory for this skill:`, `<command-*>`, `<local-command-*>`, `<system-reminder>`, `<bash-*>`, `The user just ran /`, and `# <Title> Skill` first-line skill bodies via `SKILL_HEADING_RE`). Filter applies at compaction (clean source going forward) and defensively in `filterEvidenceAfterTurn` (cleans existing v2 sessions on re-extract, no re-capture needed).
- **Trivial-prompt extraction** — added structural floor `BASE_CONFIDENCE_MIN_BODY_CHARS = 25`: candidates that score exactly at `BASE` (no boost fired) and have <25 char bodies are rejected. Catches throwaway prompts like "okay good" while letting boost-lifted short feedback (correction-prefix or ack snippet) through.
- **Benchmark wiped real cache** — `perf-suite.clearCache()` resolves the real `ai-cortex` `repoKey` when run with `--repo ai-cortex` and `fs.rmSync`'d the cache dir between scenarios. The smoke test spawned the bench without setting `AI_CORTEX_CACHE_HOME`, so every full `pnpm vitest run` wiped `~/.cache/ai-cortex/v1/<ai-cortex-repoKey>/history/` and `memory/`. Smoke test now isolates an `AI_CORTEX_CACHE_HOME` per run; `clearCache()` throws if the env var is unset (running the bench CLI directly against the real cache is now a hard error rather than silent data loss).

### Docs

- **MANUAL.md alignment** — audited and fixed 13 misalignments: storage layout (`index.sqlite` not `memory.db`; `extractor-runs/`, `trash/`, `types.json`); memory CLI table missing `bootstrap` / `extract` / `extractor-log` / `sweep` / `promote` / `install/uninstall-prompt-guide`; MCP tools table missing `extract_session` / `list_memories_pending_rewrite` / `rewrite_memory` / `promote_to_global` / `sweep_aging`; 20 memory tool param blocks said `path (optional)` but actual schemas require `repoKey: string`; `recall_memory` `tags` → `scopeTags` and missing `source` param; new `history` CLI section; bootstrap section now documents `--re-extract` / `--cwd` / `--repo-key`; cache storage layout shows full subdirectory tree; architecture documents the History + Memory data flow (hook → compact → evidence → extractor → dedup → recall); language support lists TS/JS, Python, C/C++ adapters (was "Phase 5 ships TS/JS only"); gotcha severity enum is `info | warning | critical` (was `minor | major | critical`); library API notes that history/memory layers are CLI/MCP-only.

---

## [0.5.0] — 2026-05-02

The memory layer release. ai-cortex grows from "fast project rehydration" into a three-layer local-first intelligence layer: structural (rehydrate / suggest / blast-radius), continuity (history + memory), and integration (MCP + briefing + adoption tooling). The memory layer ships end-to-end — full lifecycle, two-tier storage, auto-extraction from session evidence, aging sweeps, and subagent-driven cleanup. Plus npm distribution, opt-in adoption tooling for Claude / Codex, and a refreshed product narrative.

### Added

#### Memory layer — foundation

- **Markdown-of-record + SQLite + vector sidecar** — memories are typed (`decision`, `gotcha`, `pattern`, `how-to`), scoped (files + tags), versioned with full audit trail, and lifecycle-managed (`candidate` → `active` → `deprecated`/`merged_into`/`trashed` → `purged`). Markdown is the source of truth; SQL index and vector sidecar are derived and rebuildable.
- **Type registry** — extensible JSON config (`types.json`); built-in seed for the four standard types with bodySection + extraFrontmatter validation.
- **Lifecycle functions** — `createMemory`, `updateMemory`, `updateScope`, `deprecateMemory`/`restoreMemory`, `mergeMemories`, `trashMemory`/`untrashMemory`, `purgeMemory` (default + redact modes), `linkMemories`/`unlinkMemories`, `pinMemory`/`unpinMemory`, `confirmMemory`, `addEvidence`, `bumpConfidence`, `bumpReExtract`, `rewriteMemory`. All write through a 3-step protocol: markdown → audit → SQL+FTS+vectors.
- **Retrieval pipeline** — two-stage: SQL scope filter → cosine + recency + confidence linear ranker. Plus FTS-only `searchMemories`, `getMemory`, `listMemories`, `auditMemory`.
- **`reconcileStore` startup recovery** — on-first-call per-repoKey caching detects orphan files, phantom rows, and body-hash drift; `rebuild_index` regenerates the SQL index from `.md` files.
- **Layered config loader** — defaults → user → repo, with extractor / aging / ranking sections.

#### Memory layer — auto-extraction & bootstrap

- **Auto-extractor** — heuristic extraction from session evidence produces candidate memories using regex cues (imperative for decision, symptom for gotcha, how-question + tool-call sequence for how-to, cross-session co-occurrence for pattern). Confidence model is additive: `0.35 base + 0.10 if assistant ACK + 0.10 if user-prompt has correction-prefix`. Default `minConfidence: 0.4` floor.
- **Cross-session deduplication** — cosine ≥ 0.85 + same type + tag overlap collapses near-duplicates. Re-extraction stability bumps existing memory's `confidence` by `+0.10` and `reExtractCount` by 1.
- **`bootstrapFromHistory`** — one-shot extraction over all captured sessions; idempotent on re-run. CLI `memory bootstrap`.
- **Auto-trigger on capture** — `history capture` runs the extractor immediately after compaction; new candidates land within seconds of session end.
- **MCP `extract_session` tool** + CLI `memory extract` / `memory extractor-log` for explicit extraction control.

#### Memory layer — aging & global tier (Phase 2b)

- **`sweepAging`** core — `candidate` → `trashed` after 90d, `deprecated` → `trashed` after 180d, `merged_into` → `trashed` after 90d, `trashed` → `purged` after 90d. `stale_reference` never auto-aged. Dry-run mode previews actions without applying.
- **Low-confidence detection** — emits a more specific reason in audit when `confidence < cfg.aging.lowConfidenceThreshold`.
- **Two-tier storage** — `repoKey="global"` resolves to `~/.cache/ai-cortex/global/memory/`, parallel to project stores. `openGlobalLifecycle` and `promoteToGlobal` (with `promotedFrom` backref + auto `merged_into` on the original).
- **Cross-tier recall** — `recallMemoryCrossTier` runs both stores in parallel and merges results with a `+0.10` source boost for project results so local context outranks global on identical matches.
- **MCP tools** — `sweep_aging`, `promote_to_global`. Plus `record_memory.globalScope` parameter and `recall_memory.source: "project" | "global" | "all"` for tier control.
- **CLI** — `memory sweep`, `memory promote`, `memory recall --source`, `memory record --global-scope` (added later for CLI parity with MCP).

#### Memory layer — utility (Phase 3, this release's headline)

- **Opinionated MCP tool descriptions** — six memory tools rewritten to teach _when_ to call, not just _what_ they do. Centerpiece: **the cardinal pattern** — `recall_memory` is browse-only and does not signal usage; `get_memory(id)` is the use signal that drives cleanup eligibility.
- **Briefing memory digest** — `renderMemoryDigest` injects a "Memory available — N active, N candidates, N pinned" section + per-type top-5 + "How to consult" guidance into the rehydration briefing. Type-agnostic: queries `DISTINCT type` from SQL rather than iterating a hardcoded list, so user-registered custom types appear too.
- **Access counters** — four new SQL columns (`get_count`, `last_accessed_at`, `re_extract_count`, `rewritten_at`) added via the codebase's first idempotent ALTER TABLE migration. `get_memory` bumps `get_count` and `last_accessed_at`; `recall_memory` does not. Counter columns gate cleanup eligibility and lay the data shape for a future closed feedback loop.
- **`rewriteMemory` lifecycle function** — auto-promotes `candidate → active` (confidence 1.0); errors on terminal states (`merged_into`, `trashed`, `purged_redacted`); validates registry whenever `type` or `typeFields` change; respects `shouldPreserveBody` for audit; audits as `update` with reason `"rewrite"`. The agent's investment in rewriting is the endorsement signal.
- **Subagent-driven cleanup MCP tools** — `list_memories_pending_rewrite(repoKey, limit?, since?)` returns candidates passing the eligibility predicate (`status='candidate' AND rewritten_at IS NULL AND re_extract_count >= 1 AND (pinned = 1 OR get_count > 0)`); `since` filters on `(updated_at OR last_accessed_at)` to catch access-only eligibility. `rewrite_memory(repoKey, id, fields)` applies the cleaned rule card. **MCP-only** — no CLI parity, since manual cleanup would require a user-supplied LLM (contradicts the no-LLM-in-substrate stance).
- **`rewrittenAt` field** — new optional `string | null` on `MemoryFrontmatter`, round-tripping through markdown YAML and SQL.

#### Adoption tooling

- **`memory install-prompt-guide`** + **`memory uninstall-prompt-guide`** — write a versioned guidance block (`<!-- ai-cortex:memory-rule:start v1 -->`) to `CLAUDE.md` and/or `AGENTS.md` so the agent's system context teaches the recall→get pattern from the start. Idempotent on re-install; auto-replaces older versions; surgically removes on uninstall. Default `--scope global` (writes to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`); `--scope project` requires `--yes` to protect repo state. Default `--agent all`; `--agent claude|codex` for explicit control.

#### CLI — meta commands

- **`ai-cortex --version` / `-v` / `version`** — prints `ai-cortex <version>` reading from the bundled `package.json`.
- **`ai-cortex --help` / `-h` / `help`** — top-level command list with one-line descriptions.
- **Update-available notice** — cached daily background check against `https://registry.npmjs.org/ai-cortex/latest`. Non-blocking (runs in detached subprocess); cache at `~/.cache/ai-cortex/update-check.json`. Skips for `mcp` (would corrupt JSON-RPC), version/help (low value), `!isTTY` (CI / pipes), `CI` env var, and `AI_CORTEX_NO_UPDATE_CHECK=1` (escape hatch).

#### Documentation

- **`MEMORY_LAYER.md`** — user-facing technical reference for the memory layer (~430 lines): cardinal pattern, mental model, core loop walked through with CLI/MCP commands at each stage, common flows, storage layout, architectural decisions (pull-only, agent-agnostic, no LLM in substrate), configuration, and limitations.
- **Refreshed `README.md`** — tagline now leads with "local-first intelligence layer"; `npm install -g ai-cortex` as the primary install path; commands section gains memory subcommands and meta commands; MCP tools split into three subtables (project / memory / history) reflecting the actual 30-tool surface; architecture diagram redrawn as three-layer (structural / continuity / integration); Beta tag dropped.
- **Strategy v4** (`docs/misc/ai-cortex-strategy-v4.md`, gitignored) — competitive positioning, three explicit strategic bets (pull-only > push, agent-agnostic, no-LLM-in-substrate), wow-loop with honest gap framing.
- **Product brief v2 + high-level plan v2** (`docs/shared/`) — current-state docs replacing the v1 MVP-era originals (archived to `docs/misc/`).
- **Memory layer design specs** — `2026-04-30-memory-schema-design.md` (Phase 1 schema, lifecycle, extractor) and `2026-05-01-memory-utility-design.md` (pull-only architecture decision, briefing awareness, subagent-driven cleanup).

### Changed

- **MCP tool count** — 12 → 30. New: 21 memory tools (read, write, lifecycle, Phase 2b ops, subagent cleanup), `extract_session`. Existing memory-domain tools got opinionated descriptions teaching the recall→get distinction.
- **`MemoryFrontmatter` type** — gained `rewrittenAt: string | null` (required field). Internal API; no public-API consumers known. Lifecycle constructor sites (`createMemory`, `promoteToGlobal`) initialize to `null`; spread-based update sites carry the existing value forward.
- **`MemoryRow` type** (SQL row mirror) — gained `get_count`, `last_accessed_at`, `re_extract_count`, `rewritten_at` columns.
- **Auto-extractor heuristics** (post-implementation correction) — correction-prefix changed from a hard gate (drop the candidate if the user prompt doesn't start with `actually|wait|no|...`) to a `+0.10` confidence boost. Recovered approximately 30× of previously-dropped signal in real session captures (1.4% → ~35% of available imperative/symptom matches passing the 0.4 floor).
- **`package.json` `homepage`** — `https://github.com/ai-creed/ai-cortex` → `https://ai-creed.dev/projects/ai-cortex/` (the npm "Homepage" link now points at the landing page).
- **`docs/shared/` reorganized** — only durable project-wide knowledge stays (`product_brief.md`, `high_level_plan.md`); historical / point-in-time documents moved to `docs/misc/` (architecture assessment, phase 0 artifacts, project spike, archived v1 docs, gitignored marketing strategy).

### Fixed

- **Aging sweep `prepare<>` generic types** — `better-sqlite3`'s `Statement.all` rejected the `prepare<[], Row>` typing pattern; replaced with `prepare(sql).all(...) as Row[]` matching the rest of the codebase.
- **Misleading low-confidence test** — original test asserted "trashes a low-confidence candidate" but passed for the wrong reason (age, not confidence). Removed alongside dead `confidence` column from aging-sweep query; later re-added with proper low-confidence reason-string detection.
- **`SOURCE_BOOST` scope** — moved from function-local to module-level constant in `retrieve.ts` for testability and readability.
- **CLI `--source` flag validation** — rejected invalid values with clear error message rather than silently casting to a fallback enum value.
- **Promote CLI static import** — `runMemoryPromote` was using a dynamic `import("../reconcile.js")` inconsistent with the rest of the CLI; switched to top-level static import to match codebase convention.
- **Aging test fixture migration** — earlier extractor fix changed the iteration source from `corrections` to `userPrompts`; `tests/integration/memory-extract-cli.test.ts` fixture wasn't migrated and was producing 0 candidates instead of the expected 1.
- **Spec-review fixes during memory utility shipping** — `rewrite_memory` now validates registry on `type` change AND on `typeFields` change (not only `type`); `since` filter on the pending-rewrite queue checks `(updated_at >= ? OR last_accessed_at >= ?)` so months-old candidates accessed today via `get_memory` aren't excluded; `rewriteMemory` auto-promotes `candidate → active` (was leaving status as `candidate`, making rewrite cosmetic — recalled and aged out anyway).

### Internal

- **First SQLite migration in the codebase** — idempotent `ALTER TABLE ADD COLUMN` pattern in `openMemoryIndex`, swallowing only `duplicate column name` errors. Sets the convention for future schema extensions.
- **`logged()` middleware** wraps every MCP tool handler — call telemetry already captured, ready for adoption-aggregation work in v0.6.
- **913 → 939 tests passing** on master. One pre-existing flake (`readPackageVersion` worktree-path bug) — only visible when running tests inside a git worktree; unaffected in production CLI use.

### Known limitations (new this release)

- **Memory extractor is heuristic.** Regex-based; misses well-phrased decisions that don't match imperative/symptom cues even after the boost-not-gate fix recovered ~30× of dropped signal. An LLM-based extractor (running in user's subagent, no LLM in substrate) is a deferred future direction.
- **Memory recall on short / abbreviation-heavy queries can be weak.** Default `Xenova/all-MiniLM-L6-v2` (22M, 384-dim) handles general-English thematic matches but struggles with `cxx` ≠ `c++` and multi-hop semantic chains. Larger models (`bge-small`, `e5-small`) are deferred.
- **Closed feedback loop is foundational only.** Counters in place; reconciliation logic ("did the agent violate this rule after recalling it?") is deferred until adoption telemetry validates demand.
- **Cosmetic zsh warning during `$()` capture on macOS.** Worker threads from `@xenova/transformers` interact with zsh job control during command substitution, emitting a benign `failed to change group ID` warning. Direct invocations are unaffected. Workaround: pipe to file or `2>/dev/null` the substitution.

---

## [0.4.0] — 2026-04-30

First stable release. Drops the beta designation.

### Added

- **Python language adapter** — full import graph, call graph, and function extraction
  for `.py` files via tree-sitter-python. Supports flat layouts, src-layouts, and
  multi-root `pyproject.toml` projects. Resolves relative imports, package-root
  discovery via `setup.cfg`/`pyproject.toml`, and qualified method calls.
- **History session manifest** — append-only `manifest.jsonl` alongside sessions
  directory enables O(1) session ID enumeration and optional date-range narrowing
  before full session loads. Falls back to directory scan for existing history stores.
- **Adapter capability registry** — formal `LanguageAdapter` interface with
  `AdapterCapabilities` flags; `getAdapterForFile` and `adapterSupports` registry
  functions replace ad-hoc extension checks in `import-graph.ts` and `call-graph.ts`.

### Fixed

- **Linux adapter race condition** — concurrent `Parser.init()` calls from parallel
  adapter factories produced multiple Emscripten instances, leaving grammar data
  relocations unapplied (ABI version 0). Fixed by serializing `Parser.init()` before
  the parallel factory `Promise.all`.
- **Python phantom edges** — nested function definitions no longer emit call edges
  from uncollected caller nodes; multi-root `pyproject.toml` discovery no longer
  over-matches inline comments in `setup.cfg` `package_dir`.

### Changed

- **Async I/O throughout hot paths** — `cache-store`, `entry-files`, `import-graph`,
  `vector-builder`, `vector-sidecar`, `indexable-files`, and `history/store` fully
  migrated from sync `fs.*` calls to `fs.promises.*`. `getCachedIndex` is now async
  (the one public signature change in this release).
- **Cache lifecycle coordinator** — duplicated cache freshness logic extracted from
  `suggestRepo` and `rehydrateRepo` into a shared `resolveCacheWithFreshness`
  function, eliminating policy drift between the two callers.
- **Single-pass content buffer** — `buildIndex` now reads each source file once via
  `readFileContents` and passes the content map to `extractImports`, `extractCallGraph`,
  and `hashFileContent`, reducing per-file I/O from 2–3 reads to 1.
- **Version drift detection** — `SERVER_VERSION` in `mcp/server.ts` now imports from
  `src/version.ts`; a CI test asserts the module value matches `package.json` on every
  run, making silent version drift a build failure.

---

## [0.3.0-beta.6] — 2026-04-10

### Added

- **C/C++ language adapter** — function extraction, `#include` import graph, and
  call graph resolution for `.c`, `.cpp`, `.h`, `.hpp` files via tree-sitter-c and
  tree-sitter-cpp. Namespace and class-qualified method calls supported.
- **`blast_radius` MCP tool** — BFS traversal of the call graph from a changed
  function; surfaces affected callers with confidence signals.
- **Overload aggregation** — `blast_radius` aggregates overloaded function callers
  and surfaces `overloadCount`.
- **Adapter-driven import graph** — `import-graph.ts` refactored to route through
  the `LangAdapter` registry; canonical path resolution shared across languages.
- **`isAdapterExt` / `adapterExtensions`** — registry helpers for extension-based
  adapter lookup.

### Fixed

- C/C++ include edge lookup gated to cfamily adapter; cross-file resolution
  requires exported declarations.
- Function-pointer variables excluded from C/C++ declaration extraction.
- Incremental reindex calls `ensureAdapters` before extension filtering.
- TS import candidate strips `.ts` extension for correct `resolveSite` lookup.

---

## [0.3.0-beta.5] — 2026-03-28

### Added

- **Session history capture** — Claude Code and Codex hook integration that records
  conversation turns, extracts rule-based evidence, embeds chunk vectors, and persists
  sessions to `~/.cache/ai-cortex/v1/<repoKey>/history/`.
- **`search_history` MCP tool** — lexical and semantic search across captured sessions
  with scope resolution and auto-broadening.
- **Per-session lock** with stale recovery for concurrent capture safety.
- **`history` CLI subcommands** — `capture`, `list`, `prune`, `on`, `off`, `hooks`.
- Hook install/uninstall for Claude Code hooks shape.

### Fixed

- Session ID validation to prevent path traversal.
- Hook capture reads `session_id` from stdin JSON rather than env assumptions.

---

## [0.3.0-beta.4] — 2026-03-15

### Fixed

- Excluded `dist/tests` from npm package `files` field.
- CI: skips redundant pnpm build in `beforeAll` when `dist` already exists.

---

## [0.3.0-beta.3] — 2026-03-12

### Added

- **CI workflow** — GitHub Actions build and test on push/PR.
- npm publish workflow on version tags.

---

## [0.3.0-beta.2] — 2026-03-08

### Added

- **`suggest_files_semantic` MCP tool** — embedding-based semantic file ranking.
- **`suggest-semantic` CLI subcommand**.
- MCP tool descriptions updated to prefer ai-cortex for discovery tasks.

---

## [0.3.0-beta.1] — 2026-03-01

### Added

- **Semantic ranker** (`mode: semantic`) — `@xenova/transformers` embedding provider
  with L2 normalization, vector sidecar I/O, and singleton cache.
- **`suggest_files_deep` MCP tool** and `suggest-deep` CLI subcommand — superset
  ranker combining trigram index, content scan, and call graph signals.
- **Trigram index** — on-demand Jaccard similarity index for deep ranking pool.
- **Content scanner** — query-time grep with hit cap and budget guard.
- Ranker quality benchmark harness with 20-PR target-repo corpus.

### Changed

- `suggest_files` MCP tool defaults to deep mode.
- Call graph scoring signals wired into suggest ranker.
- Shared camelCase/snake tokenizer with stopwords.

---

## [0.1.0-beta.1] — 2026-02-01

Initial release.

### Added

- Core indexing pipeline: `indexRepo`, `getCachedIndex`, `buildIncrementalIndex`.
- Rehydration: `rehydrateRepo` with dirty worktree detection and briefing renderer.
- Suggest: `suggestRepo` with fast ranker, anchor file (`--from`), call graph signals.
- MCP server with `index_project`, `rehydrate_project`, `suggest_files` tools.
- Git-aware cache with fingerprinting, incremental diff, and schema versioning.
- TypeScript/JavaScript tree-sitter adapter with import graph and call graph.
- SHA-256 content hashing for changed-file detection.
- Evaluation harness for A/B ranking experiments.
- Benchmark suite with performance and quality scenarios.
