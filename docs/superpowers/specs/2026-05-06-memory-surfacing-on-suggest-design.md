# Memory surfacing on `suggest_files*` — design

**Status:** draft
**Date:** 2026-05-06
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
memory matcher:
  · embed task once via MiniLM
      (semantic ranker already embedded — reuse that vector)
  · candidate set = active memories where either:
      (a) scoped track:   scopeFiles overlaps any window file (via glob match), OR
      (b) unscoped track: memory has no scopeFiles
  · for each candidate: cosine(taskVec, memoryVec) ≥ threshold
        scoped track   → T_scoped   (looser)
        unscoped track → T_unscoped (stricter)
  · sort by cosine desc, tie-break getCount desc, id asc
  · cap at 3
    ↓
attach to response: relatedMemories: [{ id, title, track, scope, matchScores }]
    ↓
agent reads pointers, calls get_memory(id) on any rule it intends to apply
```

### 3.2 Wiring boundary

The matcher is a pure library function in `src/lib/memory/surface.ts`. The `suggestRepo()` library API stays unchanged — it returns file results only. Memory surfacing is composed at the MCP boundary (`src/mcp/server.ts`) by calling `surface.matchMemories(...)` on the result before returning.

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
  scope-match.ts        ← NEW. Pure utility: matchesScope(pattern, paths) → boolean.
                            Glob-only. Uses picomatch.
  surface.ts            ← NEW. matchMemories(task, suggestResult, repoKey, opts)
                            → RelatedMemory[]. Confidence gates, two-track filter,
                            cosine, sort, cap.
  retrieve.ts           ← MOD. Replace .includes(s.value) at line 317 with
                            matchesScope(). Same semantic now spans recall_memory
                            and the new surfacing path.

src/mcp/
  server.ts             ← MOD. After suggestRepo() returns, call
                            surface.matchMemories(); attach to response.
                            Update tool descriptions for the three suggest_files*
                            tools to mention relatedMemories + get_memory pattern.

src/lib/
  suggest-ranker.ts          ← UNCHANGED.
  suggest-ranker-deep.ts     ← UNCHANGED.
  suggest-ranker-semantic.ts ← MOD. Expose the query embedding it already computed
                                 so surface.ts can reuse it (avoids redundant
                                 MiniLM call). Optional optimization.

tests/unit/lib/memory/
  scope-match.test.ts   ← NEW.
  surface.test.ts       ← NEW.
tests/integration/
  suggest-with-memory-surface.test.ts ← NEW.
```

**File count:** 3 new src + 3 modified src + 3 new test = 9 files. Exceeds the 3-file-per-task threshold. Implementation plan will decompose.

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

For each `status === "active"` memory:

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
- If the pattern contains none of `* ? [ {`, fall through to literal equality (`pattern === path`). Fast path; preserves backward-compat for memories stored with concrete paths.
- Otherwise, compile via `picomatch(pattern, { dot: true })` and test against `path`. Compiled matcher is memoized per pattern within a single matcher run.
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

### 7.1 Schema additions

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

### 7.3 Tool description tweaks

Append to the description of `suggest_files`, `suggest_files_deep`, `suggest_files_semantic`:

> "When the result is high-confidence and matching memories exist, the response also includes a `relatedMemories` array of pointers. Call `get_memory(id)` on any rule you intend to apply — surfacing alone does not count as use."

The closing clause carries the recall→get contract into the agent's tool-description context.

---

## 8. `recall_memory` consistency fix

The new `scope-match.ts` utility replaces the literal-equality logic at `src/lib/memory/retrieve.ts:317`:

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

Note the argument order: stored value (the *pattern*) is the first arg to `matchesScope`; the candidate path the agent passed in is the second. Same direction as the surfacing matcher.

Effect: memories stored with glob patterns (e.g. `MainApp/**/*cardmultiselect*`) start matching the literal paths agents pass to `recall_memory(scope: { files: [...] })`. Pre-existing gap closes.

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
| Global-tier memories                               | Included. They have no scopeFiles → unscoped track with strict threshold.         |

### 9.1 Performance shape per call (when matcher runs)

| Step                                     | Cost                                                    |
|------------------------------------------|---------------------------------------------------------|
| Read memory vector sidecar               | ~5–10 ms                                                |
| Embed task (one-shot)                    | ~10–30 ms (skipped for semantic ranker — already done)  |
| Track filter via `matchesScope`           | O(memories × window-files); <5 ms at 100s of memories  |
| Cosine over candidates                   | Linear in candidates; <10 ms at 1k                      |
| **Total added latency**                  | **~25–50 ms** typical; ≤80 ms at the upper bound        |

For the semantic ranker, the task vector is reused — total added latency drops to ~15–30 ms.

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

---

## 13. Changelog

- **2026-05-06 v1**: initial draft.
