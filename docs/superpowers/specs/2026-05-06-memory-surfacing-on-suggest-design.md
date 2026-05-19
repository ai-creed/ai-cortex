# Memory surfacing on `suggest_files*` — design

**Status:** draft
**Date:** 2026-05-06

> **Revised 2026-05-19:** this spec remains the authority for pull-on-`suggest_files` surfacing and is unchanged. A separate **edit-time push-via-hook** path is now specified in `2026-05-19-edit-time-memory-surface-hook-design.md`; the two coexist.
**Scope:** MCP `suggest_files`, `suggest_files_deep`, `suggest_files_semantic` tools; memory layer match utility; `recall_memory` consistency fix.

---

## 1. Context & problem

The memory layer has a quiet failure mode: the agent has to *decide* to call `recall_memory` for a relevant rule to surface, and most of the time it doesn't, because nothing in its context tells it to. Memories silently rot. `KNOWN_LIMITATIONS.md` already names this as the central adoption risk.

Existing mitigations (briefing-phase memory digest, `memory install-prompt-guide`) are best-effort priors. They don't help when the agent has a concrete task in front of it and a relevant rule sits unread in the store.

This spec adds **task-driven memory surfacing**: when `suggest_files*` returns a confident result, the response also includes pointers to memories whose scope and content actually match the current task. The agent reads the pointers, decides whether to commit, and pulls the body via `get_memory(id)`.

The recall→get separation — surfacing pushes references; only `get_memory` bumps usage counters — is preserved by design.

---

## 2. Goals & non-goals

### Goals

- Surface relevant memories alongside `suggest_files*` results when (a) the file ranker is confident and (b) the memory matches both the task semantically and the suggested files structurally.
- Preserve the recall→get usage-signal contract. Surfacing must not mutate `getCount` or `last_accessed_at`.
- Add glob-pattern support to memory scope-matching, replacing the existing literal-only `.includes()` check used in `recall_memory`. Stored patterns like `MainApp/**/*cardmultiselect*` start matching the files they were meant to.
- Graceful degradation: any failure in the memory pipeline (missing sidecar, corrupt vector, malformed glob) leaves the file response unchanged.

### Non-goals

- **Wrapping other tools** (`Read`, `Grep`, etc.) as triggers. Only `suggest_files*` in v1.
- **Inlining memory bodies in the response.** Pointer-only.
- **Counter mutation on surface.** Only `get_memory(id)` moves counters.
- **CLI surfacing.** MCP-only in v1; CLI output stays as it is.
- **Regex pattern support.** Glob only.
- **Tag-based scope matching at the surfacing gate.** Only `scopeFiles` participates in the structural gate. `scopeTags` remains available to `recall_memory` filtering as before.
- **Cross-call deduplication.** Two `suggest_files` calls in the same session may surface the same memory; agent decides per-call.
- **Confidence-threshold override per call.** Defaults only. Add `confidenceOverride` later if real usage demands it.
- **Closed feedback loop** (did the agent honor the rule after `get_memory`?) — that's Phase 12, out of scope here.

---

## 3. Architecture

### 3.1 Call flow

```
suggest_files*(task, ...)
    ↓
file ranker runs (fast | deep | semantic) → top-K file results
    ↓
[Layer 1 confidence gate] is top-1 score above the per-ranker floor?
    ↓ no  → return files only, no memory step
    ↓ yes
[Layer 2 file window] include files where score ≥ 70% of top-1, capped at 3
    ↓
memory matcher (cross-tier):
  · embed task once via MiniLM
      (v1 always re-embeds, even on semantic-mode calls; reuse-from-ranker
      optimization deferred — preserves the suggestRepo() boundary)
  · for each store in [project, global]:
      · candidate set = active memories where either:
          (a) scoped track:   scopeFiles overlaps any window file (via glob match), OR
          (b) unscoped track: memory has no scopeFiles
      · for each candidate: cosine(taskVec, memoryVec) ≥ threshold
            scoped track   → T_scoped   (looser)
            unscoped track → T_unscoped (stricter)
  · merge: project-tier results get a small score boost (0.1) — same convention as
      `recallMemoryCrossTier` in retrieve.ts:361
  · sort by cosine desc, tie-break getCount desc, id asc
  · cap at 3
    ↓
attach to response: relatedMemories: [{ id, title, track, scope, matchScores }]
    ↓
agent reads pointers, calls get_memory(id) on any rule it intends to apply
```

### 3.2 Wiring boundary

The matcher is a pure library function in `src/lib/memory/surface.ts`. The `suggestRepo()` library API stays unchanged — it returns file results only. Memory surfacing is composed at the MCP boundary (`src/mcp/server.ts`) by calling `surface.matchMemoriesCrossTier(projectRh, globalRh, ...)` on the result before returning.

The cross-tier signature mirrors the established `recallMemoryCrossTier(projectRh, globalRh, ...)` in `retrieve.ts:363` — same caller responsibility (open both `RetrieveHandle`s, close both in `finally`), same per-tier scoring with a small project-tier boost. This is required, not optional: global-tier memories live under a separate `repoKey = "global"` store (`src/lib/memory/lifecycle.ts:874`), so a project-only matcher would silently never see promoted global rules.

The MCP wiring **must reconcile both stores before opening handles**, mirroring every other memory-reading tool in `server.ts`:

```ts
// inside the suggest_files* tool handler, after suggestRepo() returns:
return withReconcileForRepoKey(repoKey, async () => {
  await maybeReconcile(GLOBAL_REPO_KEY);   // same pattern as line 735
  const projectRh = openRetrieve(repoKey);
  const globalRh = openRetrieve(GLOBAL_REPO_KEY);
  try {
    const related = await surface.matchMemoriesCrossTier(
      projectRh, globalRh, task, suggestResult, /* opts */
    );
    return {
      content: [...],
      structuredContent: { ...suggestResult, ...(related.length && { relatedMemories: related }) },
    };
  } finally {
    projectRh.close();
    globalRh.close();
  }
});
```

The reconcile step is non-negotiable: skipping it means surfacing reads stale state that `recall_memory` would not — a memory just recorded in the current session could be invisible to surfacing while visible to recall, which is the exact kind of quiet inconsistency the recall→get model is meant to avoid.

Rationale:
- Keeps the library API focused: callers who only want file ranking get exactly that.
- Honors the "MCP-only in v1" non-goal without a feature flag.
- Future CLI/library exposure is a one-line wire-up at a different boundary.

Rationale:
- Keeps the library API focused: callers who only want file ranking get exactly that.
- Honors the "MCP-only in v1" non-goal without a feature flag.
- Future CLI/library exposure is a one-line wire-up at a different boundary.

### 3.3 Cardinal invariants

1. **Surfacing never mutates memory state.** No counter bumps, no timestamps. Read-only.
2. **Memory pipeline failure never blocks the file response.** Try/catch at the boundary; on error, log and return file results without `relatedMemories`.
3. **Empty matcher result → field omitted entirely.** Not `relatedMemories: []`. Saves tokens and avoids the agent reasoning about feature-on/off vs no-match.
4. **Only `status === "active"` memories are eligible.** Candidates and deprecated/trashed are excluded.

---

## 4. Module layout

```
src/lib/memory/
  scope-match.ts        ← NEW. Pure utility: matchesScope(pattern, path) → boolean.
                            Glob-only. Uses picomatch with per-pattern memoization.
  surface.ts            ← NEW. matchMemories(rh, task, suggestResult, opts)
                            → RelatedMemory[]. Per-store gates, two-track filter,
                            cosine, sort.
                            Plus matchMemoriesCrossTier(projectRh, globalRh, …)
                            mirroring recallMemoryCrossTier — runs both stores,
                            applies +0.1 project-tier boost, merges, caps at 3.
  retrieve.ts           ← MOD. (a) Broaden filterCandidates() SQL pre-filter so
                            glob-shaped scope rows survive stage 1 regardless
                            of caller's literal paths. (b) Apply matchesScope()
                            at the post-fetch JS filter and at scoring time
                            (line 316–317). See §8 for full diff.

src/lib/
  suggest.ts            ← MOD. Add RelatedMemorySchema; extend
                            FastSuggestResultSchema, DeepSuggestResultSchema,
                            SemanticSuggestResultSchema with optional
                            `relatedMemories: z.array(RelatedMemorySchema).optional()`.
                            Required so MCP outputSchema validates structuredContent
                            once server.ts attaches the field.
  suggest-ranker.ts          ← UNCHANGED.
  suggest-ranker-deep.ts     ← UNCHANGED.
  suggest-ranker-semantic.ts ← MOD. Expose the query embedding it already computed
                                 so surface.ts can reuse it (avoids redundant
                                 MiniLM call). Optional optimization.

src/mcp/
  server.ts             ← MOD. After suggestRepo() returns, open project +
                            global RetrieveHandles, call
                            surface.matchMemoriesCrossTier(); attach result to
                            response. Update tool descriptions for the three
                            suggest_files* tools to mention relatedMemories +
                            get_memory pattern.

tests/unit/lib/memory/
  scope-match.test.ts   ← NEW.
  surface.test.ts       ← NEW.
tests/unit/lib/memory/
  retrieve-glob-scope.test.ts ← NEW. Covers the filterCandidates broadening
                                  and the line-316 in-memory glob check
                                  together.
tests/integration/
  suggest-with-memory-surface.test.ts ← NEW.
```

**File count:** 3 new src + 4 modified src + 4 new test = 11 files. Exceeds the 3-file-per-task threshold. Implementation plan will decompose along the rollout phases in §11.

---

## 5. Confidence gate

Two layers, answering different questions.

### 5.1 Layer 1 — should the matcher run at all?

Per-ranker floor on top-1 score:

| Ranker     | Score scale                                        | Floor          |
|------------|----------------------------------------------------|----------------|
| Fast       | Unbounded sum (path × 5, fn capped at 12, anchors) | top-1 ≥ **10** |
| Deep       | Fast + trigram (0–4) + content (0–9)               | top-1 ≥ **15** |
| Semantic   | Cosine [0, 1]                                      | top-1 ≥ **0.5**|

If the gate fails, return file results without `relatedMemories`. Field omitted.

These are starting values, retunable from `benchmarks/ranker-quality/`. The bench harness gets a new dimension: which thresholds maximize recall on memory surfacing without polluting briefings with marginal hits.

### 5.2 Layer 2 — file window for scope overlap

Among the suggested files, the scoped-track structural gate uses only:

- the **top 3** by score, AND
- all files with score **≥ 70% of top-1**

whichever produces the **smaller** set. Examples:

- `top-1 = 30, top-2 = 10`: window = `[file_1]`. Single clear winner.
- `top-1 = 30, top-2 = 28, top-3 = 27`: window = `[file_1, file_2, file_3]`. Cluster.
- `top-1 = 30, top-2 = 28, top-3 = 27, top-4 = 26`: window = top 3 only (the 70% cutoff would also include top-4, but the cap wins).

Rationale: a single threshold conflates "is the call worth running memory work for" with "which files are confident enough to anchor scope-matching." Two layers keep them separate.

---

## 6. Memory matcher

### 6.1 Track selection

For each `status === "active"` memory loaded from either store (project or global), the same routing applies — global memories are not auto-routed to unscoped. Most global memories happen to be cross-cutting and ship with empty `scopeFiles`, but ones with explicit scope go through the scoped track based on their actual data:

```
if memory.scope.files.length === 0:
    track = "unscoped"
else:
    fileOverlap = scope.files.filter(p => windowFiles.some(f => matchesScope(p, f)))
    if fileOverlap.length === 0:
        track = "rejected"  // scoped memory but no window overlap
    else:
        track = "scoped"
```

Memories in track `"rejected"` are dropped before cosine computation. They neither count against the cap nor get embedded against.

### 6.2 Glob match (`scope-match.ts`)

```ts
export function matchesScope(pattern: string, path: string): boolean;
```

Implementation:
- **Normalize both inputs first** — replace `\\` with `/`, then strip a leading `./` or `/`. Picomatch is POSIX-style and won't match Windows-backslash paths against `**` patterns; the `recall_memory` call site can also receive un-normalized paths from agents on Windows. Normalization mirrors the rule already used in `src/lib/suggest-ranker.ts:24–26`. (The two sites duplicate the same 2-line helper for now; extracting a shared `path-normalize.ts` is reasonable but deferred — out of scope for this PR to keep the diff focused.)
- If the normalized pattern contains none of `* ? [ {`, fall through to literal equality (`normalizedPattern === normalizedPath`). Fast path; preserves backward-compat for memories stored with concrete paths.
- Otherwise, compile via `picomatch(normalizedPattern, { dot: true })` and test against `normalizedPath`. Compiled matcher is memoized per (normalized) pattern within a single matcher run.
- Wrap compilation in try/catch. On parse error, log a warning at debug level (`AI_CORTEX_DEBUG`-gated to avoid log spam in normal use), treat as non-matching, **never throw upward**.

Picomatch is already a transitive dep (via `chokidar` if present, or installed directly if not). Verify and add as a direct dep if needed. Bundle size impact: ~30 KB.

### 6.3 Task-match thresholds

After track selection, compute cosine against the candidate's memory vector:

| Track     | Threshold | Rationale                                                                |
|-----------|-----------|--------------------------------------------------------------------------|
| Scoped    | **0.45**  | Already passed structural gate; can afford a looser semantic bar.        |
| Unscoped  | **0.60**  | Only gate is task-match; must clear a higher bar to keep noise out.      |

Same caveat as confidence floors: starting values, tuneable via bench. The unscoped threshold is stricter than scoped — flip not recommended.

If a memory has no vector (newly recorded, embedder backlogged), `cosine = 0`. Effectively rejected unless threshold is 0.

### 6.4 Sort, tiebreak, cap

```
sort by matchScores.task descending
tiebreak by getCount descending
tiebreak by id ascending (stable)
cap at 3
```

Cap value chosen for noise discipline. Three feels like "a few worth considering"; five starts feeling like a recall dump.

---

## 7. Response shape

### 7.1 Wire format

```jsonc
{
  "mode": "deep",
  "cacheStatus": "fresh",
  "task": "card detail comment thread permissions check",
  "results": [ /* ... existing ... */ ],
  "poolSize": 60,
  "durationMs": 12,
  // ↓ new, present only when matcher returned ≥ 1 entry
  "relatedMemories": [
    {
      "id": "mem-2026-04-30-dont-mock-db-c1d2e3",
      "title": "Don't mock the database in integration tests",
      "track": "scoped",
      "scope": {
        "files": ["MainApp/lib/server/**", "tests/integration/**"],
        "tags": []
      },
      "matchScores": {
        "task": 0.78,
        "fileOverlap": ["MainApp/lib/server/email/emailqueue.ts"]
      }
    }
  ]
}
```

| Field                       | Purpose                                                                  |
|-----------------------------|--------------------------------------------------------------------------|
| `id`                        | Argument to `get_memory(id)` for commit                                  |
| `title`                     | Agent's primary signal for triage                                        |
| `track`                     | `"scoped"` or `"unscoped"`. Debug; agent may weight scoped higher.       |
| `scope.files`, `scope.tags` | Memory's stored scope, verbatim. Agent sanity-checks applicability.      |
| `matchScores.task`          | Cosine ∈ [0, 1]                                                          |
| `matchScores.fileOverlap`   | Window files the scoped pattern matched. Empty array on `unscoped` track. |

### 7.2 Empty-set behavior

- Matcher returned zero entries → omit `relatedMemories` field entirely. Not `[]`.
- Memory sidecar missing → same: omit. Indistinguishable on the wire from "no matches", which is correct: agent reasons about presence, not cause.

### 7.3 Schema additions (`src/lib/suggest.ts`)

Add a new Zod schema and extend the three result schemas:

```ts
const RelatedMemorySchema = z.object({
  id: z.string(),
  title: z.string(),
  track: z.enum(["scoped", "unscoped"]),
  scope: z.object({
    files: z.array(z.string()),
    tags: z.array(z.string()),
  }),
  matchScores: z.object({
    task: z.number(),
    fileOverlap: z.array(z.string()),
  }),
});

export const FastSuggestResultSchema = SuggestResultCommonSchema.extend({
  mode: z.literal("fast"),
  results: z.array(SuggestItemSchema),
  relatedMemories: z.array(RelatedMemorySchema).optional(),
});

export const DeepSuggestResultSchema = SuggestResultCommonSchema.extend({
  mode: z.literal("deep"),
  results: z.array(DeepSuggestItemSchema),
  poolSize: z.number(),
  contentScanTruncated: z.boolean().optional(),
  staleMixedEvidence: z.boolean().optional(),
  relatedMemories: z.array(RelatedMemorySchema).optional(),
});

export const SemanticSuggestResultSchema = SuggestResultCommonSchema.extend({
  mode: z.literal("semantic"),
  results: z.array(SuggestItemSchema),
  poolSize: z.number(),
  relatedMemories: z.array(RelatedMemorySchema).optional(),
});
```

`relatedMemories` is `.optional()` to honor §7.2 (omit when empty). The MCP `outputSchema: DeepSuggestResultSchema.shape` registrations in `src/mcp/server.ts` (e.g. line 357) automatically pick up the new field — no further change needed at registration sites. `structuredContent: result` then validates regardless of whether the matcher attached anything.

### 7.4 Tool description tweaks

Append to the description of `suggest_files`, `suggest_files_deep`, `suggest_files_semantic`:

> "When the result is high-confidence and matching memories exist, the response also includes a `relatedMemories` array of pointers. Call `get_memory(id)` on any rule you intend to apply — surfacing alone does not count as use."

The closing clause carries the recall→get contract into the agent's tool-description context.

---

## 8. `recall_memory` consistency fix

`recallMemory()` runs a two-stage pipeline. **Both stages currently use literal-string equality**, so memories with glob patterns in `scopeFiles` don't even survive the SQL pre-filter — they never reach the scoring path. Fixing only the scoring-time check (`retrieve.ts:316–317`) is insufficient.

Both stages must change.

### 8.1 Stage 1 — broaden the SQL pre-filter (`filterCandidates`, retrieve.ts:187–238)

Today's behavior at line 213–217:

```ts
scopeClauses.push(
  `EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=memories.id
           AND s.kind='file' AND s.value IN (${files.map(() => "?").join(",")}))`,
);
params.push(...files);
```

This `s.value IN (?,?,...)` is a literal-string match against `memory_scope.value`. A row with `value = 'MainApp/**/*cardmultiselect*'` will not match a caller-supplied `'MainApp/lib/cards/multiselect.ts'` here.

Replace with a clause that admits both literal hits **and** any glob-shaped row, regardless of the caller's input:

```ts
scopeClauses.push(
  `EXISTS (
     SELECT 1 FROM memory_scope s
     WHERE s.memory_id = memories.id
       AND s.kind = 'file'
       AND (
         s.value IN (${files.map(() => "?").join(",")})
         OR s.value GLOB '*[][*?{]*'   -- pattern-shaped rows survive stage 1
       )
   )`,
);
params.push(...files);
```

The `GLOB '*[][*?{]*'` predicate (SQLite's GLOB operator, classes `[`, `]`, `*`, `?`, `{`) admits any row whose stored value contains a glob metacharacter. SQLite indexes `memory_scope(memory_id, kind, value)` (per existing schema); the GLOB scan is bounded to the `kind='file'` slice and only runs when `files.length > 0`. At realistic memory-store sizes (10²–10³ rows), this is sub-ms.

### 8.2 Stage 2 — apply `matchesScope()` at scoring time (retrieve.ts:316–317)

```ts
// before
const fileHit = scopeRows.some(
  (s) => s.kind === "file" && options.scope?.files?.includes(s.value),
);

// after
const fileHit = scopeRows.some(
  (s) =>
    s.kind === "file" &&
    options.scope?.files?.some((f) => matchesScope(s.value, f)),
);
```

This is the refinement step — glob-shaped rows that survived stage 1 are now filtered against the caller's actual paths via `matchesScope(pattern, path)`. Rows where the pattern doesn't match get scope-score 0 and fall away naturally.

Argument order: stored value (the *pattern*) is the first arg to `matchesScope`; the candidate path the caller passed in is the second. Same direction as the surfacing matcher.

### 8.3 Why both stages

Skipping stage 1 means glob-scoped memories never enter the candidate pool — the scoring fix at line 316 has nothing to fix. Skipping stage 2 means literal-only filtering at scoring time would still gate out globs even though stage 1 admits them. Both are necessary; neither is sufficient alone.

### 8.4 Effect

Memories stored with glob patterns (e.g. `MainApp/**/*cardmultiselect*`) start matching the literal paths callers pass to `recall_memory(scope: { files: [...] })`. The pre-existing gap closes for both `recall_memory` and the new surfacing path, which share the `scope-match.ts` utility.

This change is intentionally bundled with the new feature: scope creep accepted because both surfaces would otherwise have divergent matching semantics, and the literal-only `recall_memory` behavior is a real bug independent of the surfacing work.

---

## 9. Edge cases

| Case                                               | Behavior                                                                          |
|----------------------------------------------------|-----------------------------------------------------------------------------------|
| Memory vector sidecar missing or corrupt           | Try/catch around `readMemoryVector`; treat as `cosine = 0`. Field likely omitted. |
| Memory just recorded, no vector yet                | Same: `cosine = 0`. Effectively rejected unless threshold is 0.                   |
| Glob pattern malformed (`MainApp/[unclosed`)       | `matchesScope` catches picomatch error, logs at debug, returns false. No throw.   |
| Task string very short (`"foo"`)                   | Embedding still runs; thresholds filter out weak cosines naturally.                |
| Same memory surfaces across two calls in one session | No cross-call dedup. Agent decides per-call. Counter only moves on `get_memory`. |
| No memories exist for the project                  | Matcher short-circuits; task is never embedded; ~zero overhead.                   |
| Pinned memories                                    | No special treatment. Pin protects from aging, doesn't bias surfacing.            |
| Global-tier memories                               | Loaded from a separate `repoKey="global"` store via `matchMemoriesCrossTier`. Routed through scoped/unscoped tracks based on their actual `scopeFiles`. Project-tier results get a +0.1 score boost on merge. |
| Global memory store missing entirely               | Treat the global side as empty result; project-side surfacing proceeds normally. Logged at debug. Independent failure modes per tier. |
| Both stores fail to open                           | Top-level try/catch around `matchMemoriesCrossTier`; field omitted; file response unchanged. |
| Reconcile step throws (project or global)          | Wrapped in the surface-side try/catch. File response succeeds; `relatedMemories` field omitted; debug-log the failure. The reconcile call already exists in every other memory-reading tool; failure modes are well-trodden. |
| Caller-supplied path is Windows-style (`a\b\c.ts`) | Normalized in `matchesScope` (backslash → slash, strip leading `./` or `/`). Test in §10.1 covers this. |
| Stored pattern was authored on Windows (rare)      | Same normalization applied to the pattern arg before picomatch compilation. Fast path also re-checks normalized literal equality. |

### 9.1 Performance shape per call (when matcher runs)

| Step                                     | Cost                                                    |
|------------------------------------------|---------------------------------------------------------|
| Read memory vector sidecar               | ~5–10 ms                                                |
| Embed task (one-shot)                    | ~10–30 ms (always; v1 does not reuse the semantic ranker's embed) |
| Track filter via `matchesScope`           | O(memories × window-files); <5 ms at 100s of memories  |
| Cosine over candidates                   | Linear in candidates; <10 ms at 1k                      |
| **Total added latency**                  | **~25–50 ms** typical; ≤80 ms at the upper bound        |

In v1 the matcher always re-embeds the task even on semantic-mode calls — the reuse-from-ranker optimization is deferred to keep `suggestRepo()` as the single library entry point (spec §3.2). Cost is uniform across modes: ~25–50 ms typical. If profiling later shows semantic latency matters, the deferred path is to add an opt-in `extras: { taskVec?: Float32Array }` out-param to `suggestRepo`.

---

## 10. Testing

### 10.1 Unit (`scope-match.test.ts`)

- Literal patterns match via fast path (no globbing).
- Glob patterns: `**`, `*`, `?`, `[abc]`, `{x,y}` all behave as picomatch defines.
- Malformed pattern (e.g. `[unclosed`) returns false, does not throw.
- Memoization: same pattern called twice compiles once (assert via spy or compile counter).
- Path is matched as a forward-slash POSIX-style path; Windows-style backslash paths normalized before matching.

### 10.2 Unit (`surface.test.ts`)

- Confidence gate L1 rejects below per-ranker floor (one test per ranker).
- Confidence gate L2 narrows window correctly (single-winner case, cluster case, 4+-file 70% case capped at 3).
- Scoped track: file overlap via glob produces match; no overlap drops memory.
- Unscoped track: stricter threshold applied.
- Cap at 3 enforced.
- Sort + tiebreak: equal task-match → higher getCount wins; equal both → id asc.
- Status filter: candidate, deprecated, trashed all excluded.
- Memory with no vector → cosine 0, rejected.
- Empty memory store → returns `[]`.

### 10.3 Integration (`suggest-with-memory-surface.test.ts`)

- End-to-end: seeded fixture project + fixture memory store; `suggest_files` MCP call returns expected `relatedMemories`.
- Glob-patterned memory matches a literal-path top-K hit.
- Memory pipeline error (corrupt sidecar) does not block file response; field omitted.
- Tool description includes the new clause.

### 10.4 `recall_memory` regression

- Existing tests for `retrieve.ts` continue to pass.
- New: glob-patterned scope file matches a literal path passed in `options.scope.files`.

### 10.5 Bench harness

`benchmarks/ranker-quality/` gains a new dimension: for each test query, assert (a) which memories *should* surface (golden), (b) which *do* surface, (c) noise count (memories surfaced that shouldn't have). Drives threshold tuning post-ship.

---

## 11. Rollout

1. **Phase A — utility + recall_memory fix.** Ship `scope-match.ts` + `retrieve.ts` swap. Standalone PR. No behavior change for surfacing; just unifies match semantics. Risk: minimal, well-scoped.
2. **Phase B — surface.ts + MCP wire-up.** Ship the matcher and MCP boundary integration. Tool descriptions updated. New behavior gated behind no-op-when-empty: zero noise on projects with no memories.
3. **Phase C — bench tuning.** Run `benchmarks/ranker-quality/` against the new dimension on a sample corpus. Tune the four thresholds (3 ranker floors + 2 task-match gates). Adjust defaults if the corpus reveals a clearly-better setting.

Phases A and B can ship in successive minor releases. Phase C is post-ship calibration.

---

## 12. Open questions

- **Picomatch as direct dep vs transitive.** Verify current dependency tree; install as direct if not already pulled in.
- **Should v2 add per-call confidence override?** Hold until real users push for it.
- **Is the 70%-of-top-1 window a meaningful signal at fast-mode score scales?** Fast scores are unbounded and bunch differently. May need a per-ranker window strategy if bench reveals fast-mode produces too-narrow or too-wide windows.
- **Stage-1 GLOB pre-filter cost at scale.** The `s.value GLOB '*[][*?{]*'` clause adds a sequential scan of the file-kind slice of `memory_scope` per `recall_memory` / surfacing call. At 10²–10³ rows this is sub-ms; at 10⁵+ it could matter. Consider adding a denormalized `is_glob` boolean column with an index if profiling shows it.

---

## 13. Changelog

- **2026-05-06 v1**: initial draft.
- **2026-05-06 v2**: addressed three review findings: (1) §8 rewritten — `recall_memory` glob fix now covers both the SQL stage-1 pre-filter and the stage-2 scoring check (the v1 spec only changed the latter, so glob-scoped memories were still pruned before reaching it); (2) §3.1 / §3.2 / §6.1 / §9 updated — matcher now opens both project and global memory stores via `matchMemoriesCrossTier`, mirroring the existing `recallMemoryCrossTier` pattern (the v1 spec referenced global-tier inclusion without describing how the matcher reads it); (3) §4 / §7.3 added — `src/lib/suggest.ts` listed as modified; `RelatedMemorySchema` and the three result-schema extensions documented (the v1 spec attached `relatedMemories` to the response without extending the Zod schemas that back the MCP `outputSchema`).
- **2026-05-06 v3**: addressed two further review findings: (4) §3.2 expanded — MCP wiring now explicitly mirrors `withReconcileForRepoKey(repoKey, …)` + `maybeReconcile(GLOBAL_REPO_KEY)` before opening `RetrieveHandle`s, matching every other memory-reading tool in `server.ts`. v2 omitted the reconcile step, so surfacing would have read pre-reconcile state (visible mismatch with `recall_memory` for memories recorded mid-session). (5) §6.2 / §9 updated — `matchesScope` now normalizes both inputs (`\\` → `/`, strip leading `./` or `/`) before comparing, mirroring `src/lib/suggest-ranker.ts:24–26`. v2 had a §10.1 test for Windows-path normalization but no implementation rule; picomatch is POSIX-style and would have failed the test.
- **2026-05-06 v4**: spec text aligned with implementation-plan review findings: §3.1 + §9.1 — semantic-mode reuse of the ranker's task embedding is deferred for v1 (preserves the `suggestRepo()` library boundary called out in §3.2; cost is one extra ~10–30 ms embed per semantic call, within the latency envelope). The plan instead always re-embeds in `attachRelatedMemories`. No change to wire format or other contracts.
