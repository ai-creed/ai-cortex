# Memory Capture Redesign — Design

**Date:** 2026-05-17
**Status:** Draft, awaiting plan
**Scope:** replace the accept-by-default memory extraction heuristic with a structural noise-killer gate + agent-mediated confirmation; triage the existing legacy candidate backlog.

## Problem

The extractor (`src/lib/memory/extract.ts`, 681 lines) turns nearly every user prompt into a `status:"candidate"` memory via shallow lexical regexes (`IMPERATIVE_RE`, `SYMPTOM_RE`, `HOW_TO_RE`) at `BASE_CONFIDENCE 0.35` plus small boosts. The result is the transcript, relabeled.

Empirical evidence (full corpus scan, 208 candidates across 5 projects):

- **~9–13 of 208 (~5%) are genuine durable memories.** The rest are raw task imperatives, UI tweaks, debug chatter, session/process control, questions, harness pseudo-prompts, pasted-doc blobs, and code-review findings dumps.
- **Confidence is inversely correlated with quality.** Every high-confidence row (0.55–0.95, `version` 16–31) is re-ingested boilerplate (pasted `AGENTS.md`, `This session is being continued…`, `<task-notification>`, repeated findings dumps). Real keepers sit at 0.35–0.45. The `re_extract_count`/confidence promotion path actively rewards the worst noise.
- **A stricter positive-signal classifier is provably lossy.** Spot-checked real keepers it would wrongly reject: *"CLAUDE_SESSION_ID is too specific to claude. We should make it agnostic…"*, *"Don't put call-graph in the prompt as grep use that more efficiently…"*, *"Don't be specific with -review postfix … we might extend to have more tools later."* — none contain `always/never/because/since`; the rationale is implicit. Lexical rules cannot see meaning; that is the same category error as the current gate.
- **Structural noise is shape-obvious and safe to reject.** ~51+ rows are identifiable purely by structure (`#`/`<INSTRUCTIONS>`/`High:`/`This session is being continued`/`<task-notification>`), and **none of the ~12 keepers has any of those shapes** — zero false-negative risk on structural rejection, high false-negative risk on positive classification.

Conclusion: the gate must be a **structural noise-killer, not a positive classifier**, and the precision burden must move to an LLM. ai-cortex is network-free, so the LLM is the calling agent via MCP.

## Goals

1. Stop flooding `candidate` with transcript turns: a structural gate that drops ~88% of turns with near-zero loss of genuine memories.
2. Make the durability judgment an explicit, well-affordanced agent (LLM) step over a small surviving set.
3. Triage the existing legacy backlog through the same pipeline — no blind deletion.
4. No new network dependency, no new status enum, reuse existing lifecycle (`confirm`/`deprecate`/`rewrite`).

## Non-goals

- An LLM provider/key/config inside ai-cortex. The calling agent is the only LLM.
- A new memory status. `candidate` + existing lifecycle is sufficient.
- Rewriting good prose in the gate. The gate only rejects; the agent rewrites survivors into rule cards.
- Recall-maximizing capture. Bias is precision; genuinely recurring rules are recovered over time (the agent re-encounters and confirms them).

## Constraints

- ai-cortex performs no network calls and no LLM calls. The gate is pure/offline. Judgment is the calling agent via MCP.
- No writes into target repos; all state under `~/.cache/ai-cortex/v1/<repoKey>/` (unchanged).
- Reuse `status:"candidate"`, `confirmMemory` (→active), `deprecateMemory` (→rejected), `rewriteMemory`. No new lifecycle states.

## Architecture / data flow

```
session transcript (evidence layer)
        │
        ▼
┌──────────────────────────────────────────────┐
│ GATE — structural hard-rejects only           │  ~88% dropped, ≈0 keeper loss
│ (no positive-signal survival requirement)     │
└──────────────────────────────────────────────┘
        │ survivors
        ▼
  create status:"candidate" source:"extracted"      ← unchanged lifecycle
  body = raw user turn + assistant snippet + provenance
  (signalScore is NOT stored — recomputed from body at query time)
  (confidence-based promotion DISABLED for extracted)
        │
legacy candidates ──► same GATE re-filter ──► structural noise: deprecate
                                              survivors: stay candidate ──┐
        │                                                                 │
        ▼                                                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ CONFIRM AFFORDANCE (agent = LLM, via MCP)                                 │
│ • rehydrate briefing: "Captures pending confirmation — N" (own section)   │
│ • review_pending_captures({worktreePath,limit?,since?}) → batch +         │
│   context: transcript-window | evidence-pair | body-only + signalScore    │
│ • agent: rewrite_memory → confirm_memory (→active)  |  deprecate_memory    │
└──────────────────────────────────────────────────────────────────────────┘
```

One gate, one queue, one lifecycle. Fresh and legacy converge; they differ only in `context` fidelity (fresh → transcript-window or evidence-pair; legacy → usually body-only, sessions pruned).

## Gate — structural noise-killer

Rewrite `src/lib/memory/extract.ts`. The `produce*` extractors stop being positive classifiers. Per candidate-turn, ordered structural hard-rejects (first match → discard, never created):

1. **Pasted-doc blob** — trimmed body starts with `#`, `<INSTRUCTIONS>`, or matches known doc headers (`AGENTS.md`, skill-doc titles, `🧠`).
2. **Harness pseudo-prompt** — contains `This session is being continued from a previous conversation`, `<task-notification>`, `<tool-use-id>`, `<image name=`, or is `[Image #\d]`-dominant (>50% of body is the ref).
3. **Findings dump** — `^\s*(\d+\.\s*)?(High|Medium|Critical|Major|Low|P[12]):` or contains "check/more/some findings", "one more pass", "one last finding".
4. **Error/log paste** — `Uncaught .*Error|TypeError|ENOENT|EISDIR|exited with code|npm error|API Error:\s*\d|-32601|UserWarning|build failed` or opens with "got (some )?error|still the same|saw this error|got this running|how about this error".
5. **UI micro-tweak** — `too dimmed|smaller|bigger|too big|lighter|bolder|gradient|\d+px|margin|flex column|align|highligh|looks (bad|ugly)|broken layout|titlebar|fps|unreadable|line break|capitalized` AND no standing-directive lexeme present.
6. **Session/process control + vague-ack** — first non-space token ∈ `{ok, okay, good, alright, yes, no, fine, "got it", "b.", "a.", <bare digit>.}` OR contains `let'?s? (write|brainstorm)|write plan|push to master|just merge|continue with the rest|go ahead with phase|sync plan|write this down|kill your shell|monitor and fix|smoke test`.
7. **Question** — `?` within the first 200 chars AND no standing-directive lexeme (`always|never|by default|from now on|prefer .{0,40} over|as a rule`).
8. **Filler** — trimmed body < 25 chars.

A turn that passes all 8 is **created** as `status:"candidate"`, `source:"extracted"`, body = raw user turn + next-assistant snippet + provenance `{sessionId, turn}`. There is **no positive-signal requirement to be created** — positive classification was proven lossy; the agent is the durability judge.

`signalScore` (0–3): +1 standing-directive lexeme, +1 rationale connective (`because|since|so that|to avoid|otherwise|too specific|we might (extend|need)|as .{0,30}(more|better|efficiently)|reads better`), +1 durable-correction shape (correction prefix + non-deictic code/convention object).

**Not stored.** `signalScore` is a pure, deterministic function of the candidate body — `signalScore(body): 0..3` lives next to the gate and is **recomputed at query time** by `review_pending_captures` (which already reads each body). No SQLite column, no frontmatter field, no migration — this is what keeps "no schema change" true. Used **only** to order the confirm queue; never gates creation, never persisted.

**Confidence-promotion disabled for extracted candidates.** `re_extract_count` and confidence no longer auto-bump or auto-promote `source:"extracted"` memories (it rewarded re-ingested boilerplate, evidenced by the v16–31 noise rows). Extracted candidates leave `candidate` only via the agent confirm/deprecate step. (Explicit, non-extracted memories are unaffected.)

Existing cosine dedup (`DEFAULT_DEDUP_COSINE 0.85`) is unchanged.

## Confirm affordance

"Pending confirmation" predicate: exactly `source='extracted' AND status='candidate'`. A confirmed memory is `active`; a rejected one is `deprecated`/`trashed` — both fall out of `status='candidate'` automatically, so no extra "acted-on" flag is needed. This population **intentionally overlaps** the existing aging-cleanup pending-rewrite queue (`status='candidate' AND rewritten_at IS NULL`): they are the same rows seen two ways. The capture-confirm flow is the **primary** action (review soon, while context is fresh); the 90d cleanup loop is the **backstop** for anything the agent never gets to. The new briefing section and the cleanup section may both reference a row until it is confirmed/deprecated — that is by design, not a conflict.

**New read-only MCP tool** `review_pending_captures({ worktreePath, limit?, since? })`:
- Returns a batch (default ≤15) ordered by `signalScore` desc then recency. Each item: `id`, provisional title, raw body, **`context`**, `signalScore`, source `{sessionId, turn}`.
- `context` is resolved by a defined fallback hierarchy (a `SessionRecord` stores `evidence` + lossy `chunks` + a `transcriptPath`; raw surrounding turns exist only in `transcriptPath`, which may be absent/pruned — `rawDroppedAt` — even when the session record still exists):
  1. **`transcriptPath` readable** → parse a window of the source turn ± N turns (`{ kind: "transcript", turns: [...] }`).
  2. **else the evidence pair** → `evidence.userPrompts[turn].text` + its `nextAssistantSnippet` (≤500 chars; present for v2 sessions) (`{ kind: "evidence", userTurn, assistantSnippet }`). This is the common case and is exactly what the gate itself saw.
  3. **else body-only** → `{ kind: "body-only" }` (legacy/pruned; the agent judges from the candidate body alone).
- The item always carries `context.kind` so the agent knows the fidelity of what it's judging.
- Read-only — it does not mutate; it never bumps `get_count`/`last_accessed_at` (mirrors the read-only-reader constraint used elsewhere).

**Agent decision loop** (existing lifecycle, no new code there). `rewriteMemory` and `confirmMemory` each **independently** promote a `candidate` to `active` (`rewriteMemory`: `status==='candidate' → 'active'`, confidence 1.0, `rewrittenAt` set; `confirmMemory`: throws unless still `candidate`). They are therefore **mutually exclusive — never call both on the same id** (the second throws "confirmMemory only from candidate, not active"). Exactly one terminal action per candidate:
- Durable but the raw body needs reshaping into a rule card → `rewrite_memory(id, …)` **alone** (this promotes to `active`; do **not** also call `confirm_memory`).
- Durable and the body is already a clean, generalizable statement as-is → `confirm_memory(id)` **alone** → `active`.
- Not durable → `deprecate_memory(id, reason)` → rejected.
- Unsure → leave it; ages out via the existing 90d cleanup loop.

**Surfacing (dual):**
- Rehydrate briefing gains a dedicated section `## Captures pending confirmation — N`, separate from the existing `## Pending review … cleanup` section, with the `review_pending_captures` → `rewrite`/`confirm`/`deprecate` workflow and the precision framing ("most extracted captures are noise; keep only durable, generalizable rules").
- `captureSession` (session-end) stages survivors immediately, so they are present when the next session rehydrates and the nudge fires while a fresh session can still resolve transcript windows.

## Legacy triage migration

One-shot, idempotent, lazy on first rehydrate per repo after upgrade (mirrors `runRepoKeyMigrationIfNeeded` + its sentinel):

- Select all `source='extracted' AND status='candidate'`.
- Run each body through the new structural gate. Structural-noise → `deprecateMemory(id, "legacy triage: structural noise")` (auditable, recoverable, ages out — not hard-deleted).
- Survivors stay `candidate` and automatically satisfy the `review_pending_captures` predicate. Legacy survivors usually resolve to `context.kind: "body-only"` (sessions pruned); the agent judges from the body.
- Completion sentinel prevents re-run / double-deprecation.
- Expected on current data: ~180/208 auto-deprecated; ~25–30 surface for agent confirm; ~9–13 become `active`.

## Edge / error states

- Empty evidence layer / no user turns → no candidates (unchanged).
- History session pruned (or `transcriptPath` unreadable, or pre-v2 session with no `nextAssistantSnippet`) when `review_pending_captures` runs → `context` degrades down the hierarchy (transcript → evidence-pair → body-only); never an error.
- Migration runs with a corrupt/locked index → migration aborts cleanly, sentinel NOT written (retried next rehydrate); never crashes rehydrate.
- A turn matches both a hard-reject and would have high `signalScore` → hard-reject wins (structural rejects evaluated first; ordering is the point — see the "Ok, sound good … fold into agents.md" ordering-bug lesson: the trailing-clause case is handled by the agent on the rare survivor, not by trying to lexically rescue it in the gate).

## Testing strategy

| Layer | Coverage | Mechanism |
|---|---|---|
| Structural hard-rejects | Each of the 8 rules: a real-corpus noise sample (anonymized) is dropped; the ~12 verbatim keepers all survive | unit, table-driven |
| Gate end-to-end | Fixture evidence layer → only survivors created; assert confidence/`re_extract_count` no longer bumps or promotes `source:"extracted"` | unit |
| `signalScore` | pure function of body, deterministic; recomputed at query time (asserted: no DB column / frontmatter field written); orders the queue; never gates creation | unit |
| `review_pending_captures` | predicate selects only unconfirmed extracted candidates (excludes confirmed/deprecated); `context` fallback hierarchy exercised at each level (transcript-window / evidence-pair / body-only) incl. `context.kind` correctness; limit/order by recomputed `signalScore`; read-only (no get_count bump) | unit, fixture index + history (session present, transcript pruned, pre-v2 no-snippet, fully pruned) |
| Confirm loop | rewrite→confirm→active; deprecate→rejected (reuse existing lifecycle tests) | unit |
| Legacy triage migration | structural-noise→deprecated; keepers→candidate + in queue; idempotent re-run no-ops; sentinel honored; corrupt index aborts without sentinel | integration, tmpdir cache w/ seeded legacy candidates |
| Briefing | "Captures pending confirmation — N" appears iff N>0, separate from cleanup section | unit (briefing-digest) |
| Regression corpus | the 208-row taxonomy distilled to a checked-in anonymized fixture: assert the noise buckets are killed and the keeper set survives (precision/recall guardrail vs future rule drift) | unit |

## Rollout

- Minor feature, no schema change, no new deps, no network.
- Version bump deferred to the plan.
- Docs: README memory section gains a short "Capture confirmation" note; CHANGELOG entry; the rehydrate-briefing copy update is part of the feature.

## Risks + mitigations

- **Gate rule drift** silently changes precision → the checked-in regression corpus fixture fails loudly if a rule starts dropping a keeper or keeping a known-noise bucket.
- **A real keeper is structurally shaped like noise** (e.g. a rule the user pasted under a `#` heading) → accepted residual risk; the structural rejects were validated to have ~zero overlap with the 12 keepers on real data; the agent never sees it but such cases are rare and the user can still record explicitly.
- **Legacy migration over-deprecates** → deprecate (not delete) keeps it auditable/recoverable; the regression fixture includes legacy-shaped keepers to bound this.
- **Agent never runs the confirm loop** → captures simply remain `candidate` and age out at 90d via the existing cleanup loop; no unbounded growth (and far less volume now that the gate kills 88%).
- **Confirm queue still too noisy for the agent** → `signalScore` ordering surfaces the most plausible first; `limit` bounds batch size; precision framing in the briefing sets the agent's bar.

## Open questions

None at design freeze. Gate strategy (structural-only), LLM source (calling agent via MCP), confirm flow (reuse candidate lifecycle + new read tool + dual surfacing), legacy handling (re-gate → agent queue, deprecate not delete), and confidence-promotion removal are all decided and data-validated.

## File map

```
src/
  lib/memory/
    extract.ts              (rewrite: structural gate; drop positive-classifier + extracted confidence-promotion; add signalScore)
    capture-triage.ts       (new: one-shot legacy triage migration + sentinel)
    briefing-digest.ts      (+ "Captures pending confirmation" section)
  mcp/
    server.ts               (+ review_pending_captures read-only tool; wire triage into rehydrate)
tests/
  unit/lib/memory/extract-gate.test.ts
  unit/lib/memory/extract-signalscore.test.ts
  unit/lib/memory/capture-triage.test.ts
  unit/lib/memory/briefing-captures.test.ts
  unit/mcp/review-pending-captures.test.ts
  fixtures/memory-capture-corpus.ts          (anonymized noise buckets + the ~12 keepers)
  integration/legacy-capture-triage.test.ts
```
