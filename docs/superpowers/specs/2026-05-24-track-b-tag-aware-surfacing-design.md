# Track B: tag-aware memory surfacing — design

**Status:** draft
**Date:** 2026-05-24
**Scope:** edit-time `surface-hook` Tier 2 tag fallback; new SessionStart workflow-rules surface; `install-hooks` reach extended to Codex CLI; `rehydrate_project` install-state-aware fallback; CLI `ai-cortex memory list-workflow-rules`.

> **Follow-up to:** `2026-05-19-edit-time-memory-surface-hook-design.md` (Track A precondition: legacy-scope self-heal, shipped 2026-05-23).

> **Revised 2026-05-24 (review pass):** clarified mixed-scope Tier 2 fallthrough semantics in §2 and §9; corrected Codex hook TOML to the documented nested-handler form in §6.1 and §6.3; unified telemetry shape across §7 and §10 to use a `tiers` array parallel to `memoryIds`; added required usage-signal-invariant regression coverage to §9.

---

## 1. Context & problem

Track A repaired memories whose scope was misplaced — frontmatter empty, scope stranded in body trailers. After reconcile, those memories are properly file-scoped and the existing `matchSurfaceMemories` matcher surfaces them at edit time.

A second class of memory is still unreachable by auto-surfacing: **memories that are correctly scoped, but tag-only**. These are workflow rules that apply to commands or cross-cutting practices, not to specific files:

| Memory id (Favro example) | `scope.files` | `scope.tags` | When it applies |
|---|---|---|---|
| `mem-2026-05-15-…07b043` | `[]` | `[commit, favro-commit-auto, git, skill]` | Any commit |
| `mem-2026-05-07-…154446` | `[]` | `[git, history-rewrite, rebase, safety]` | After any rebase / amend / filter-branch |
| `mem-2026-05-15-…664803` | `[]` | `[commit-hygiene, fixup, git, rebase, tests]` | Test fix on the wrong commit |
| `mem-2026-05-20-…da9a79` | `[]` | `[agent-behavior, memory-discipline, meta]` | Mid-session pattern repetition |

The current `matchSurfaceMemories` explicitly excludes tag-only memories (`surface-core.ts:52`: `// exclude unscoped/tag-only`). The earlier suggest-side spec (`2026-05-06`) lists tag-based matching at the surfacing gate as a Non-goal. As a result, an agent edits and commits its way past these rules with no signal that they exist. The 2026-05-21 postmortem documents 5+ raw `git commit --no-verify` calls in a single session while `favro-commit-auto` sat unreached.

**The premise of this spec.** Tag-only memories cannot file-scope themselves — they apply to commands or workflows, not files. Surfacing them requires either (a) a non-file signal at edit time, or (b) a separate surface outside the per-edit hook. This spec ships both, on a two-prong design.

---

## 2. Goals & non-goals

### Goals

- **Prong A — edit-time tag fallback:** the existing PreToolUse(Edit/Write/MultiEdit/apply_patch) hook gains a Tier 2 match that admits tag-only AND mixed-scope memories via normalized-token overlap between the file path and the memory's `scope.tags`. Tier 1 file-scope match retains precedence for any memory whose `scope.files` matches the current path. A mixed-scope memory (`scope.files.length > 0 && scope.tags.length > 0`) whose `scope.files` does NOT match the current path is **eligible for Tier 2** via its `scope.tags`. No memory is double-counted across tiers — Tier 2 always excludes ids already selected in Tier 1 (§3.1).
- **Prong B — session-start workflow rules surface:** a new SessionStart hook (Claude Code + Codex) emits a curated list of active tag-only workflow memories on session startup, resume, clear, and (where supported) compact. The list re-fires on resume, surviving compaction-erasure of the original session-start context.
- **Both prongs ship for both CLIs:** Claude Code and Codex have functionally equivalent PreToolUse and SessionStart contracts (Codex docs confirmed — see §8.1). Codex install is enabled.
- **Preserve the recall→get usage-signal contract.** Surfacing pushes pointers; only `get_memory(id)` bumps counters. Same invariant Track A preserved.
- **Best-effort with acceptable noise.** Surfacing is a suggestion, not a directive. The cap and the existing per-session dedup ledger keep the agent's signal-to-noise tolerable. Average precision is the design target; perfect precision is not.
- **Preserve the 2026-05-06 spec's suggest-gate Non-goal.** Tier 2 tag matching is opt-in via a `matchSurfaceMemories` parameter; the PreToolUse hook opts in, the `suggest_files*` `relatedMemories` path does not. The earlier "Only `scopeFiles` participates in the structural gate" commitment for `suggest_files*` holds.

### Non-goals

- **Synonym maps / embedding-based tag similarity.** v1 uses normalized-token overlap only. `git` ≈ `repo`, `e2e` ≈ `end-to-end` are accepted misses. Revisit if telemetry shows the miss rate is high.
- **Bash-command-class surfacing.** Rejected: by the time the agent is about to run `git commit`, the wrong file edit has already shipped. Surfacing at commit-time can't undo earlier work, so PreToolUse(Bash)-triggered surfacing is not in v1.
- **UserPromptSubmit-based surfacing.** Rejected: token cost per turn + noisy intent inference. Possible future work.
- **Continuation-session detection amplification.** Postmortem §5.3 idea — surface a louder reminder when SessionStart detects a recent prior session end. Out of scope; SessionStart's existing `resume` matcher gives us most of the recovery we need without an extra signal layer.
- **Tag canonicalization / merge tooling.** Tag drift (`unit-test` vs `unit-tests` vs `Unit Tests`) is handled at match time by normalization, not at write time by canonicalization. A future store-side tag-curation tool is possible but not in this spec.
- **Cross-call deduplication for the SessionStart surface.** The hook fires once per session-start matcher (startup, resume, clear, compact); we don't dedup across those. The per-edit ledger continues to dedup Prong A as today.
- **Counter mutation on surface.** Surfacing remains pointer-only. Only `get_memory(id)` moves `getCount` and `last_accessed_at`.
- **Cross-tier (global store) surfacing.** Prong A Tier 2 stays project-tier only, matching Tier 1's existing scope (`surface-core.ts` is documented as a "project-tier matcher"). Prong B's workflow-rules listing also reads from the project tier only in v1. A future track may extend either to read the global store via the `recallMemoryCrossTier` pattern — out of scope here.
- **`suggest_files*` `relatedMemories` Tier 2 extension.** The 2026-05-06 spec's Non-goal stands; `attachRelatedMemories` continues to call `matchSurfaceMemories` without the Tier 2 opt-in. If future telemetry shows suggest-side tag matching is worth it, that's a separate track.

---

## 3. Architecture

### 3.1 Call flow — Prong A (edit-time)

```
PreToolUse fires (Edit | Write | MultiEdit | apply_patch)
    ↓
surface-hook reads tool_input → relPaths (existing)
    ↓
matchSurfaceMemories(rh, relPaths, { tier2: true }) — extended:
  Tier 1 — file-scope match (existing, unchanged)
    candidate pool: active memories with non-empty scope.files
    rank: pattern specificity → getCount desc → updatedAt desc → id asc
    take min(matched-hits, CAP)        ← CAP bumped from 3 to 5
    ↓
  Tier 2 — tag-fallback match (NEW)
    fires only when |Tier-1 result| < CAP
    candidate pool: active memories with non-empty scope.tags,
                    MINUS ids already selected in the Tier-1 result set.
                    A mixed-scope memory whose scope.files did NOT match the
                    current path is included in this pool (its absence from the
                    Tier-1 result set, not from the Tier-1 candidate pool, is
                    what matters for the no-double-counting invariant).
    signal: normalized tokens from relPaths
    score: |path-tokens ∩ tag-tokens|, with a +1 bonus if any matched tag
           is in the project's top-N popular tags
    rank: score desc → getCount desc → updatedAt desc → id asc
    take min(CAP - |Tier-1 result|, remaining)
    ↓
combined results = Tier-1-result ++ Tier-2-result (Tier 1 always ranks above Tier 2)
    ↓
existing surface-ledger dedup keyed on file path (unchanged)
    ↓
emit hookSpecificOutput.additionalContext (existing format, same buildContext)
```

### 3.2 Call flow — Prong B (session-start)

```
SessionStart fires (startup | resume | clear | compact)
    ↓
hook invokes: ai-cortex memory list-workflow-rules --repo-key=$repoKey --format=hook
    ↓
CLI:
  open lifecycle index for repoKey
  candidates: active memories where
              scope.files.length == 0
              scope.tags.length > 0
              type ∈ {"decision", "how-to"}
  sort: pinned desc → getCount desc → updatedAt desc → id asc
  cap: N (default 10, configurable via AI_CORTEX_WORKFLOW_LIST_CAP)
    ↓
CLI emits JSON: {"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<formatted list>"
  }}
    ↓
harness injects additionalContext as a system-reminder
```

### 3.3 Surface coordination — `rehydrate_project` fallback

`rehydrate_project`'s briefing already contains a "Memory available" section. v1 adds a sibling "Workflow rules" section governed by install-state:

```
on rehydrate_project call:
  if SessionStart hook for ai-cortex workflow rules is INSTALLED for this CLI:
    skip "Workflow rules" section (the hook covers this surface)
  else:
    include "Workflow rules" section (call the same library function as the CLI)
```

Install-state detection reuses the existing `hooksMigrationStatus()` / hook-config-reading machinery in `src/lib/history/hooks-install.ts` (already in use for the `v0.10.3` hook migration notice). Detection key: presence of a marker-suffixed SessionStart entry in `~/.claude/settings.json` (Claude Code) or `~/.codex/config.toml` (Codex).

The "smart" behavior matches the user-stated requirement: rehydrate doesn't repeat what the hook already emitted.

### 3.4 Wiring boundary

- **Prong A logic** lives in `src/lib/memory/surface-core.ts` (extended) plus a new pure module `src/lib/memory/tag-overlap.ts` for the normalization + scoring primitives.
  - `matchSurfaceMemories(rh, relPaths, opts?: { tier2?: boolean })` — new optional `opts` parameter. `tier2: true` enables the new fallback. **Both callers must be updated by name** (compile-time visibility), not by default-flag flip:
    - `src/lib/memory/cli/surface-hook.ts:144` — pass `{ tier2: true }`.
    - `src/mcp/server.ts:attachRelatedMemories` — leave call site as-is (no opts arg), preserving the 2026-05-06 Non-goal.
  - The CLI hook entrypoint `surface-hook.ts` is unchanged externally; only its single call site to `matchSurfaceMemories` grows the opts arg.
- **Prong B logic** lives in a new module `src/lib/memory/workflow-rules.ts` (pure selection + formatting) consumed by:
  - new CLI command `src/lib/memory/cli/list-workflow-rules.ts` (the SessionStart hook target)
  - `src/lib/briefing.ts` (the `rehydrate_project` briefing renderer; install-state-gated, see §3.3)
  - CLI dispatch in `src/cli.ts` registers `list-workflow-rules` as a subcommand of `memory` (alongside the existing `surface-hook`, `record`, etc.).
- **Install changes** live in `src/lib/history/hooks-install.ts`:
  - re-enable Codex PreToolUse install (currently gated off)
  - bump Claude Code PreToolUse timeout `5s → 10s`
  - install SessionStart hook for both CLIs
  - extend `hooksMigrationStatus()` (`src/lib/history/hooks-install.ts`) to recognize the new hook signature as the canonical post-install state, so the v0.10.3 migration notice triggers a one-time "needs install" nudge for existing users until they re-run `ai-cortex history install-hooks`. Documented user experience: the briefing surfaces the same neutral nudge as v0.10.3, agent runs install, the new entries land.

---

## 4. Tag-overlap matching (Prong A Tier 2)

### 4.1 Normalization

The same normalization applies to path tokens and tag tokens.

```typescript
function normalize(s: string): string[] {
    return s
        .toLowerCase()
        .split(/[-_./\s]+/)        // split on hyphen, underscore, dot, slash, whitespace
        .map(stripBasicPlural)     // "tests" → "test", "boxes" → "box", "fixes" → "fix"
        .filter((t) => t.length > 1) // drop single-char fragments
        .filter(Boolean);
}

function stripBasicPlural(t: string): string {
    if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
    if (t.endsWith("es") && t.length > 3)  return t.slice(0, -2);
    if (t.endsWith("s")  && t.length > 2)  return t.slice(0, -1);
    return t;
}
```

Examples:

| Input | Output |
|---|---|
| `Services/server/import_matching.app-test.ts` | `{services, server, import, matching, app, test, ts}` |
| `unit-tests` | `{unit, test}` |
| `e2e` | `{e2e}` |
| `git-commits` | `{git, commit}` |

### 4.2 Scoring

For each Tier 2 candidate memory `m`:

```typescript
function tagOverlapScore(
    pathTokens: Set<string>,
    memoryTags: string[],
    popularTagSet: Set<string>,
): number {
    let score = 0;
    let popularHit = false;
    for (const tag of memoryTags) {
        const tagTokens = new Set(normalize(tag));
        for (const t of tagTokens) {
            if (pathTokens.has(t)) {
                score += 1;
                if (popularTagSet.has(tag)) popularHit = true;
            }
        }
    }
    if (popularHit) score += 1;
    return score;
}
```

A memory matches Tier 2 if `score > 0`. Tied scores break by `getCount desc → updatedAt desc → id asc` (same convention as Tier 1).

### 4.3 Popular-tag set

Computed at most once per repoKey per process (cached). Definition: the top-20 most frequently occurring tags across active memories in the project store, computed from the existing `memory_scope` table (`SELECT value FROM memory_scope WHERE kind = 'tag' GROUP BY value ORDER BY COUNT(*) DESC LIMIT 20`). Cached on a `RetrieveHandle` field; recomputed when the handle is closed and reopened.

The popular-tag set is a tiebreaker boost, not a filter. Memories with rare tags still match if their tokens overlap path tokens.

### 4.4 What the algorithm catches and misses

✅ Catches:
- Hyphen / underscore / whitespace variants (`unit-tests` ≈ `unit_tests` ≈ `Unit Tests`)
- Basic singular/plural (`test` ≈ `tests`, `commit` ≈ `commits`)
- Path-segment overlap with tag tokens (`Test/src/foo.app-test.ts` matches a memory tagged `app-test` or `unit-tests`)
- Compound tag tokens (`favro-commit-auto` decomposes to `{favro, commit, auto}` — any token match registers)

❌ Misses (accepted for v1):
- True synonyms (`git` ≈ `repo`, `push` ≈ `upload`)
- Acronym expansion (`e2e` ≈ `end-to-end`, `db` ≈ `database`)
- Domain-specific paraphrase (`fixup` ≈ `amend`)

### 4.5 Cap

`CAP = 5` (bumped from 3). The cap covers Tier 1 + Tier 2 combined. Tier 1 takes its hits first; Tier 2 fills the remaining slots up to the cap.

The cap bump matters in two scenarios:
- File has 2 file-scope hits → 3 Tier 2 slots open, fillable from tag fallback.
- File has 5 file-scope hits → Tier 2 doesn't fire at all. Same as today, just with a higher headroom.

The dedup ledger continues to operate per-file. Combined cap-5 result set is the unit of dedup.

---

## 5. SessionStart workflow rules surface (Prong B)

### 5.1 Selection

A memory is eligible for the workflow rules listing iff:

```
status        === "active"
scope.files.length === 0
scope.tags.length  > 0
type          ∈ {"decision", "how-to"}
```

`pattern`, `gotcha`, and `capture` types are excluded by design:
- `pattern` is the design-spec / code-layout kind, generally not workflow rules
- `gotcha` is a one-shot debugging trap, less likely to be a recurring workflow rule
- `capture` is unconfirmed agent-extracted text; not yet curated

The selection is intentionally narrow. The point is to surface a digest of high-value workflow constraints, not the whole tag-only universe.

### 5.2 Sort & cap

Sort: `pinned desc → getCount desc → updatedAt desc → id asc`.

Cap: 10 (default), overridable via env `AI_CORTEX_WORKFLOW_LIST_CAP`. Cap exists to keep the SessionStart context block bounded (~1 KB of tokens per session-start emit).

### 5.3 CLI

```
ai-cortex memory list-workflow-rules
    [--repo-key=<16hex>] [--cwd=<path>]      # one of these; defaults to cwd
    [--limit=<N>]                            # default from AI_CORTEX_WORKFLOW_LIST_CAP or 10
    [--format=text | json | hook]            # default text
```

- `--format=text` — human-readable bulleted list (for CLI inspection)
- `--format=json` — structured JSON (machine-readable, for tooling)
- `--format=hook` — emits a JSON line of the SessionStart hook contract: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}`

Empty results (no qualifying memories) emit empty `additionalContext` in hook mode, prints an empty `[]` in JSON mode, or prints a single line in text mode.

### 5.4 Output format (text body, shared across CLI and rehydrate)

```
## Workflow rules — <N> active

- [<id>] <title> (<type>)
- [<id>] <title> (<type>)
- …

Call `get_memory(id)` to consult any rule before doing relevant work.
Surfaced ≠ relevant — do NOT get_memory ones that do not apply.
```

When emitted via the SessionStart hook, this body is wrapped as `additionalContext` in the harness's standard `<system-reminder>` channel:

```
<system-reminder>
ai-cortex: <N> workflow rules active in this project.

- [mem-2026-05-15-…07b043] Always use favro-commit-auto skill for commits (decision)
- [mem-2026-05-07-…154446] Verify zero diff after git history rewrite (decision)
- …

Call `get_memory(id)` to consult any rule before doing relevant work.
Surfaced ≠ relevant — do NOT get_memory ones that do not apply.
</system-reminder>
```

### 5.5 Failure contract

The SessionStart hook follows the same `never-block` contract as the PreToolUse surface hook:

- IO error opening the index → silent allow, empty `additionalContext`
- Empty result set → emit JSON with no `additionalContext` field (or empty string)
- Deadline hit → silent allow

The CLI exit code is always 0 on the hook code path. Non-zero exit reserved for `--format=text|json` argument errors.

---

## 6. Install-hooks changes

### 6.1 Re-enable Codex PreToolUse install

`src/lib/history/hooks-install.ts:applyCodexInstall` currently writes only history-capture hooks for Codex (the surface hook was gated off per the stale §13 KNOWN_LIMITATIONS note — see §8.1). Re-enable the PreToolUse surface hook entry:

```toml
[[hooks.PreToolUse]]
matcher = "apply_patch"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "ai-cortex memory surface-hook"
# Codex default 600s; no explicit timeout needed
```

Codex's hook contract per https://developers.openai.com/codex/hooks: each event-typed array entry (`[[hooks.PreToolUse]]`) declares a `matcher` (regex string against `tool_name`), and a nested `[[hooks.<Event>.hooks]]` table declares the handler with `type` and `command`. We deliberately scope the matcher to `apply_patch` only — Codex's PreToolUse also fires for `Bash` and MCP tool calls, but Bash-triggered surfacing is a v1 non-goal.

### 6.2 Bump Claude Code PreToolUse timeout

`applyInstall` writes the PreToolUse entry with `timeout: 5000` today. Bump to `10000`:

```json
{
  "matcher": "Edit|Write|MultiEdit",
  "hooks": [
    { "type": "command", "command": "ai-cortex memory surface-hook", "timeout": 10000 }
  ]
}
```

Rationale: Tier 2 tag fallback adds a candidate scan over up to ~hundreds of active tag-only memories per project. The work is cheap (microseconds per candidate after the index query), but cold-start opening of the SQLite index, fs IO contention from concurrent processes, and embedding-related warm-ups push the p99 above 5 s in some environments. The internal `DEADLINE_MS = 250` soft deadline in `surface-hook.ts` stays as-is and is the real gate; 10 s harness timeout is cushion against environmental variance.

### 6.3 Install SessionStart hook (both CLIs)

Claude Code (`~/.claude/settings.json`):

```json
{
  "matcher": "startup|resume|clear|compact",
  "hooks": [
    { "type": "command", "command": "ai-cortex memory list-workflow-rules --format=hook", "timeout": 10000 }
  ]
}
```

Codex (`~/.codex/config.toml`) — documented nested-handler form (regex matcher, nested `[[hooks.SessionStart.hooks]]` handler table):

```toml
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"

[[hooks.SessionStart.hooks]]
type = "command"
command = "ai-cortex memory list-workflow-rules --format=hook"
```

Marker comment / sentinel: a `# ai-cortex:workflow-rules` marker line above each entry, so `hooksMigrationStatus()` can detect the install state (§6.4).

### 6.4 Install-state detection in rehydrate

`rehydrate_project`'s briefing renderer (`src/lib/briefing.ts`) gains a new section conditional on install state:

```typescript
function shouldIncludeWorkflowRulesSection(cli: "claude" | "codex"): boolean {
    return !sessionStartWorkflowHookInstalled(cli);
}
```

`sessionStartWorkflowHookInstalled` reads the relevant settings file and looks for the marker (`# ai-cortex:workflow-rules` or the equivalent JSON entry). Reuses the existing config parsing from `hooks-install.ts`.

The function is best-effort — if reading the settings file throws, default to `true` (include section in rehydrate). The fallback path errs on the side of surfacing too much, not too little.

---

## 7. Storage / type / schema changes

**No on-disk or SQL schema changes.** Both prongs read existing fields:
- `memory.scope.files`, `memory.scope.tags`, `memory.type`, `memory.status`, `memory.pinned`
- `memory_scope` table (already populated; Track A's `legacyRepaired` path ensures this is canonical)
- No new tables, no new columns, no new audit change types

The popular-tag set (§4.3) is computed on the fly from `memory_scope`; no schema change.

**TypeScript type extensions (non-breaking):**

- `SurfacePointer` in `src/lib/memory/surface-core.ts` gains an optional `tier?: "file" | "tag"` field. Tier 1 hits set `tier: "file"`; Tier 2 hits set `tier: "tag"`. Consumers that don't read the field are unaffected. Telemetry (§10) and any future debugging UI use it.
- `matchSurfaceMemories(rh, relPaths, opts?: { tier2?: boolean })` — see §3.4.
- `appendSurfaceEvent` payload (`src/lib/stats/surface-events.ts`) gains an optional `tiers?: ("file" | "tag")[]` array (parallel to the existing `memoryIds`). Optional for back-compat with existing cache rows.

**No Zod / outputSchema changes.** None of the touched code paths bind to MCP `outputSchema` registrations except `attachRelatedMemories`, which is explicitly excluded from Tier 2 (§3.4) — so the existing `FastSuggestResultSchema` / `DeepSuggestResultSchema` / `SemanticSuggestResultSchema` shape is preserved.

---

## 8. Compatibility & migration

### 8.1 Retire `KNOWN_LIMITATIONS §13`

The current §13 entry claims Codex 0.130.x doesn't fire PreToolUse for `apply_patch`/Bash. The Codex CLI hooks documentation at https://developers.openai.com/codex/hooks (verified 2026-05-24) lists PreToolUse, SessionStart, and UserPromptSubmit as fully supported, with the same `hookSpecificOutput.additionalContext` contract and a 600 s default timeout.

**Verification path before retiring the note:** run an end-to-end test against current Codex CLI (>= 0.130.x) editing a file in a test project with the surface hook installed; confirm `additionalContext` reaches the model. If the empirical behavior matches the docs, retire §13. If not, keep §13 with a tightened version constraint and ship Prong A for Claude only in v1.

This verification is a precondition for §6.1 (re-enabling Codex install).

### 8.2 No data migration

Existing memory files and SQLite rows are read as-is. No on-disk format change.

### 8.3 Backward compatibility of the existing surface-hook

The existing PreToolUse Edit/Write/MultiEdit hook continues to behave identically when no tag-only memories match. Tier 2 only fires when Tier 1 returned fewer than `CAP` hits — and even then, only when a path-token / tag-token overlap exists.

Users on older Claude Code or Codex versions without SessionStart hook support get the rehydrate-fallback automatically (install-state detection sees no hook entry, includes the section).

---

## 9. Testing strategy

### 9.1 Unit tests

- **`tag-overlap.test.ts`** — `normalize`, `stripBasicPlural`, `tagOverlapScore` against fixture cases including the §4.4 catches and misses.
- **`workflow-rules.test.ts`** — filter (status / file-empty / tags-nonempty / type-in-set), sort (pinned-first, getCount tiebreaker, updatedAt newer-first), cap.
- **`surface-core.test.ts`** — extended with Tier 2 scenarios:
  - file-scope returns 2 → tag fallback fills up to 3 more (combined cap 5);
  - file-scope returns 0 → tag fallback fills up to 5;
  - **mixed-scope memory whose `scope.files` matches the current path** is ranked in Tier 1 only and is excluded from Tier 2 candidate evaluation (no double-counting);
  - **mixed-scope memory whose `scope.files` does NOT match the current path but whose `scope.tags` overlap path tokens** is surfaced via Tier 2 (the §2 Goal fallthrough case);
  - empty Tier 2 candidate set yields the Tier-1-only result unchanged.
- **`usage-signal-invariant.test.ts`** — capture `getCount` and `last_accessed_at` (via `idx.getMemory(id)`) for every memory in the test fixture **before and after** each surfacing path:
  - `runSurfaceHook` invocation that produces Tier 1 hits;
  - `runSurfaceHook` invocation that produces Tier 2 hits (file-scope empty, tag-fallback only);
  - `runSurfaceHook` invocation that produces mixed Tier 1 + Tier 2 hits;
  - `list-workflow-rules --format=hook` invocation;
  - `rehydrate_project` briefing render that emits the workflow-rules section.
  Assert byte-equal snapshots for all counters across all five scenarios. The only mutation surface remains `get_memory(id)`; surfacing must never write to counter columns.

### 9.2 Integration tests

- **`surface-hook-tier2.test.ts`** — drive the CLI hook with a `tool_input.file_path` that has no file-scope match but has tag-overlap; assert `additionalContext` includes the tag-matched memory's pointer.
- **`list-workflow-rules.test.ts`** — CLI invocation against a synthetic store with mixed memory types; verify `--format=hook` JSON shape, `--format=text` body, empty-store behavior.
- **`rehydrate-workflow-fallback.test.ts`** — rehydrate against a repo with (a) the SessionStart hook installed → section absent; (b) hook not installed → section present.
- **`surface-events-telemetry-shape.test.ts`** — assert `appendSurfaceEvent` payload shape: `tiers` is an array of length `memoryIds.length`, each element is `"file"` or `"tag"` corresponding to the source tier of the same-index memory id. A mixed-tier event (Tier 1 + Tier 2 in one emit) MUST produce a `tiers` array containing both values in their correct positions; this is the test that locks §7 and §10 against the prior scalar-vs-array contradiction.

### 9.3 End-to-end / hook-level tests

- **`install-hooks-codex-reenabled.test.ts`** — `install-hooks` writes both PreToolUse and SessionStart entries to `~/.codex/config.toml` in the documented nested form:
  - PreToolUse: `[[hooks.PreToolUse]]` with `matcher = "apply_patch"` (regex string), followed by `[[hooks.PreToolUse.hooks]]` with `type = "command"` and `command = "ai-cortex memory surface-hook"` (command as a single string, not a TOML array; no top-level `command` field on `[[hooks.PreToolUse]]`);
  - SessionStart: `[[hooks.SessionStart]]` with `matcher = "startup|resume|clear|compact"`, followed by `[[hooks.SessionStart.hooks]]` with `type = "command"` and `command = "ai-cortex memory list-workflow-rules --format=hook"`;
  - `uninstall-hooks` removes both event arrays AND their nested handler tables in one pass (no dangling `[[hooks.PreToolUse.hooks]]` orphans).
- **`install-hooks-timeout-bump.test.ts`** — `install-hooks` writes `timeout: 10000` for Claude Code PreToolUse (not 5000).

### 9.4 Manual verification (precondition)

Per §8.1, run an actual Codex CLI session with the hook installed; confirm `additionalContext` reaches the model. Record the Codex CLI version and command used; document in the corresponding KNOWN_LIMITATIONS update.

---

## 10. Telemetry

- Extend the existing `surface-events` cache-only telemetry (`src/lib/stats/surface-events.ts`) with one new field per event: `tiers?: ("file" | "tag")[]`, **parallel to the existing `memoryIds` array** (same length, same index correspondence). Each element records the tier the memory id at the same index was sourced from. A mixed-tier emit (Tier 1 + Tier 2 in one event) is represented unambiguously by mixed values in the `tiers` array. The field is optional for back-compat with pre-Track-B cache rows. (This is the same shape declared in §7; the two sections must agree.)
- Add a new event type `workflow-rules-emit` recording `{ ts, session_id, source: "startup"|"resume"|"clear"|"compact", count }` for each SessionStart-hook emit.
- Both are cache-only writes via the existing best-effort path; never blocks the hook.

These feed the `ai-cortex stats sessions` adoption report. The §9.2 `surface-events-telemetry-shape.test.ts` locks the array form against the prior scalar-vs-array drift.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tier 2 surfaces noisy / irrelevant memories | Cap-5 unchanged in spirit (capped); popular-tag bonus is small; per-file dedup ledger applies; recall→get separation means agent still decides. Telemetry tracks Tier 2 emit rate and `get_memory` follow-through. |
| Codex docs vs reality drift | §8.1 verification gate before re-enabling Codex install; ship Claude-only fallback if empirical test fails. |
| SessionStart hook fires multiple times per session (startup + auto-resume) | Acceptable — each emit is a fresh system-reminder, the agent reads it once and moves on. The cost is bounded (cap-10 × ~50 tokens). |
| Synonyms / acronyms miss too often (`git` ≈ `repo`) | Accepted v1 limitation; revisit with embedding fallback in a future track if telemetry shows the miss rate matters. |
| Popular-tag-set computation latency on cold start | Cached per RetrieveHandle. Cold-call cost is one SQLite GROUP BY over `memory_scope` — milliseconds. Well within the 250 ms internal deadline. |
| `rehydrate_project` install-state detection wrong (stale settings file, etc.) | Falls back to "include section" on read failure — rehydrate surfaces too much, not too little. |
| Tag-only workflow rules deprecated by user but still listed | Selection already filters `status === "active"`; deprecate_memory removes from the listing on next emit. |

---

## 12. Out-of-scope follow-ups (future tracks)

- **Synonym map / embedding tag similarity.** If §4.4 misses prove costly, add a tiny per-project synonym dictionary first, then consider reusing MiniLM cosine.
- **Continuation-session amplification.** Postmortem §5.3 idea — louder `<system-reminder>` when a recent prior session end is detected. SessionStart's `resume` matcher covers most cases; this would catch corner cases where the harness doesn't fire the resume matcher.
- **UserPromptSubmit-based intent surfacing.** Catch planning-phase decisions before any tool call. Would extend coverage upstream of PreToolUse. Token-cost trade-off pending real-world measurement.
- **Tag canonicalization / merge tool.** Drift between `unit-test`, `unit-tests`, `Unit Tests` is handled at match-time by normalization. A periodic canonicalization pass could unify them at the source, simplifying recall too.
- **Per-Bash-command tag surfacing.** Postmortem §5.2 idea. Rejected for v1 (too late to act), but a future track could surface "you're about to commit — relevant rules: X, Y, Z" as a last-line-of-defense reminder.

---

## 13. Glossary & references

- **`matchSurfaceMemories`** — `src/lib/memory/surface-core.ts`, the file-scope matcher used by both the PreToolUse hook and `suggest_files`'s `relatedMemories`. Tier 2 extends this function.
- **`surface-hook`** — `src/lib/memory/cli/surface-hook.ts`, the CLI command Claude Code and Codex invoke from their PreToolUse hooks. Unchanged externally in this spec.
- **`install-hooks`** — `src/lib/history/hooks-install.ts`, the writer of `~/.claude/settings.json` and `~/.codex/config.toml` hook entries.
- **`rehydrate_project`** — MCP tool emitting the project briefing at session start. Gains the workflow-rules section conditional on install state.
- **Surface ledger** — `src/lib/memory/surface-ledger.ts`, per-session per-file dedup state.
- **Track A** — `2026-05-23-track-a-legacy-scope-self-heal` plan; reconcileStore self-heal for legacy malformed scope shapes. Shipped 2026-05-23. Precondition for this work (Tier 2 candidates must have valid `scope.tags` in canonical frontmatter; Track A ensured legacy memories were canonicalized).
- **Postmortem** — `~/.assistant-preferences/local-docs/ai-cortex/misc/postmortem-memory-bypass-2026-05-21.md` (local, not committed). Source of the failure-mode evidence in §1.
- **Codex CLI hooks reference** — https://developers.openai.com/codex/hooks (verified 2026-05-24).
