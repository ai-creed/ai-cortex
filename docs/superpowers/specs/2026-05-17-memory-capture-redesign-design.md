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
4. No new network dependency, no new status enum, reuse existing lifecycle (`confirm`/`deprecate`/`rewrite`). One additive registry seed type (`capture`) — not a status, not a schema change.

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
  create status:"candidate" source:"extracted" type:"capture"  ← unchanged lifecycle
  body = raw user turn + assistant snippet + provenance
  (signalScore is NOT stored — recomputed from body at query time)
  (confidence-based promotion DISABLED for extracted)
        │
legacy candidates ──► same GATE re-filter ──► structural noise: deprecate
                                              survivors: candidate + retype type:"capture" ──┐
        │                                                                 │
        ▼                                                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ CONFIRM AFFORDANCE (agent = LLM, via MCP)                                 │
│ • rehydrate briefing: "Captures pending confirmation — N" (own section)   │
│ • review_pending_captures({worktreePath,limit?,since?}) → batch +         │
│   context: transcript-window | evidence-pair | body-only + signalScore    │
│ • agent: rewrite_memory ALONE | confirm_memory ALONE (→active) |          │
│          deprecate_memory (→rejected)   — exactly one per candidate        │
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

A turn that passes all 8 is **created** as `status:"candidate"`, `source:"extracted"`, `type:"capture"`, body = raw user turn + next-assistant snippet + provenance `{sessionId, turn}`. There is **no positive-signal requirement to be created** — positive classification was proven lossy; the agent is the durability judge.

**Provisional type `capture`.** `createMemory` validates `type` against the type registry and throws on an unknown type (`lifecycle.ts:141`), so a survivor needs a valid type — but the gate deliberately does not classify (regex type-guessing was half the original noise problem: every imperative → `decision`). Resolution: add one built-in seed type `capture` to the type registry, meaning "extracted, not yet judged or categorized." It has no required `bodySections`/`typeFields` (any raw body is valid).

**Required: a real registry-seed migration.** `ensureRegistry` today only writes `SEED` when `types.json` is *absent* (`registry.ts:56`); existing repos (every project with a memory store) keep their old file and would never gain `capture` → `createMemory(type:"capture")` would throw `unregistered type: capture`. So this feature must add an idempotent seed-merge: on registry load/ensure, if the persisted `version < REGISTRY_VERSION`, merge missing `builtIn` seed types into the persisted registry (union — never drop or overwrite *user-defined* types), set `version = REGISTRY_VERSION`, rewrite `types.json`. `REGISTRY_VERSION` bumps to `2`.

**Collision policy — `capture` is a reserved built-in.** Exactly one exception to "never overwrite": the seed-merge **force-writes the built-in `capture` spec** (no required `bodySections`/`typeFields`), overriding a same-named pre-existing entry, because the gate's `createMemory(type:"capture", body:<raw>)` requires `capture` to accept any body. If a pre-existing `capture` entry had a *different* spec (user previously defined their own), the migration overwrites it and emits a one-time stderr diagnostic naming the override (auditable; the few memories already typed `capture` keep their stored bodies and are unaffected — only the type *spec* changes, and `capture` having no requirements can't retroactively invalidate them). Rationale for override-not-rename: a stable, predictable reserved name keeps the gate, the queue predicate, the briefing, and the browser all referring to one well-known type; an internal-mangled name (`__capture__`) leaks ugliness into user-facing type tags for no benefit. `capture` is documented as reserved. This migration is a first-class deliverable, not a footnote, and is exercised by tests (old registry without `capture` → after load, `capture` present, user types intact, idempotent on re-run). The gate stamps every survivor `type:"capture"`. **Type categorization, like durability, is the agent's job at confirm**, not the gate's: the agent assigns the real type via `rewrite_memory(type, typeFields, body)`, which already validates against the registry and reshapes the body into that type's sections. Consequently, for a fresh extraction the terminal action is **almost always `rewrite_memory`** (it sets the real type *and* structures the body); `confirm_memory`-alone applies only in the rare case where the raw body is already a clean, correctly-typed statement (which a `capture` raw turn essentially never is).

**Capture trust is governed by `status`, not the `type` tag.** A `capture`-typed memory is *always* `status:"candidate"` by construction. The invariant "no `active` memory is still typed `capture`" is upheld because the **only** promote path for a `capture` candidate is `rewrite_memory`, which sets a real type *and* promotes in one op. `confirm_memory`-alone does **not** change `type` (`confirmMemory` only flips status+confidence, `lifecycle.ts:704`), so confirming a `type:"capture"` row would create the forbidden `active+capture` state — therefore `confirm_memory`-alone is **disallowed for `type:"capture"` candidates** (see the decision loop). `capture`→`active` happens exclusively via `rewrite_memory`. Recall/surface behavior is therefore **unchanged and needs no type-aware logic**: proactive surfacing on `suggest_files` is already `active`-only (`surface.ts` `includeStatus:["active"]`) so unjudged captures never appear there; explicit `recall_memory` already down-weights `candidate` to 0.5× vs `active` 1.0× (`retrieve.ts`) and is browse-only. `capture` is a **triage/browser label** (lets the pending-confirmation queue and memory browser cleanly separate "unreviewed" from real typed memories) — not a validity signal the agent reasons about. Explicitly **do not** add `type='capture'` filtering into recall: it would be a redundant second source of truth for trust; trust = `status`, full stop. The redesign already improves recall trust by shrinking the candidate pool ~8× (gate kills ~88%).

`signalScore` (0–3): +1 standing-directive lexeme, +1 rationale connective (`because|since|so that|to avoid|otherwise|too specific|we might (extend|need)|as .{0,30}(more|better|efficiently)|reads better`), +1 durable-correction shape (correction prefix + non-deictic code/convention object).

**Not stored.** `signalScore` is a pure, deterministic function of the candidate body — `signalScore(body): 0..3` lives next to the gate and is **recomputed at query time** by `review_pending_captures` (which already reads each body). No SQLite column, no frontmatter field, no migration — this is what keeps "no schema change" true. Used **only** to order the confirm queue; never gates creation, never persisted.

**Confidence-promotion disabled for extracted candidates.** `re_extract_count` and confidence no longer auto-bump or auto-promote `source:"extracted"` memories (it rewarded re-ingested boilerplate, evidenced by the v16–31 noise rows). Extracted candidates leave `candidate` only via the agent confirm/deprecate step. (Explicit, non-extracted memories are unaffected.)

**Dedup-hit behavior (redefined for extracted captures).** Today on a cosine-dedup hit `extractFromSession` does three things (`extract.ts:182–189`): `addEvidence`, `bumpConfidence(+0.1)`, `bumpReExtract`. The last two are the disabled promotion path and must not run for `source:"extracted"`. New rule: the cosine-dedup *matcher* (`DEFAULT_DEDUP_COSINE 0.85`, `findDedupTarget`) is unchanged, but on a hit for an extracted capture the gate **appends provenance/evidence only** (`addEvidence`) and does **not** call `bumpConfidence` or `bumpReExtract`. Effect: a recurring rule accumulates provenance entries (useful context for the agent at confirm) without inflating confidence or `re_extract_count` (which we proved rewards re-ingested boilerplate). For non-extracted memories the old bump behavior is retained.

## Confirm affordance

"Pending confirmation" predicate: exactly `source='extracted' AND status='candidate'`. A confirmed memory is `active`; a rejected one is `deprecated`/`trashed` — both fall out of `status='candidate'` automatically, so no extra "acted-on" flag is needed. This population **intentionally overlaps** the existing aging-cleanup pending-rewrite queue (`status='candidate' AND rewritten_at IS NULL`): they are the same rows seen two ways. The capture-confirm flow is the **primary** action (review soon, while context is fresh); the 90d cleanup loop is the **backstop** for anything the agent never gets to. The new briefing section and the cleanup section may both reference a row until it is confirmed/deprecated — that is by design, not a conflict.

**New read-only MCP tool** `review_pending_captures({ worktreePath, limit?, since? })`:
- Returns a batch (default ≤15) ordered by `signalScore` desc then recency. Each item: `id`, provisional title, raw body, **`context`**, `signalScore`, source `{sessionId, turn}`.
- `context` is resolved by a defined fallback hierarchy (a `SessionRecord` stores `evidence` + lossy `chunks` + a `transcriptPath`; raw surrounding turns exist only in `transcriptPath`, which may be absent/pruned — `rawDroppedAt` — even when the session record still exists):
  1. **`transcriptPath` readable** → parse a window of the source turn ± N turns (`{ kind: "transcript", turns: [...] }`).
  2. **else the evidence pair** → find the `evidence.userPrompts` row where `u.turn === source.turn` (`turn` is a turn number, not an array index — match on the field, do not index), then use `u.text` + its `nextAssistantSnippet` (≤500 chars; present for v2 sessions) (`{ kind: "evidence", userTurn, assistantSnippet }`). This is the common case and is exactly what the gate itself saw.
  3. **else body-only** → `{ kind: "body-only" }` (legacy/pruned; the agent judges from the candidate body alone).
- The item always carries `context.kind` so the agent knows the fidelity of what it's judging.
- Read-only — it does not mutate; it never bumps `get_count`/`last_accessed_at` (mirrors the read-only-reader constraint used elsewhere).

**Agent decision loop** (existing lifecycle, no new code there). `rewriteMemory` and `confirmMemory` each **independently** promote a `candidate` to `active` (`rewriteMemory`: `status==='candidate' → 'active'`, confidence 1.0, `rewrittenAt` set; `confirmMemory`: throws unless still `candidate`). They are therefore **mutually exclusive — never call both on the same id** (the second throws "confirmMemory only from candidate, not active"). Exactly one terminal action per candidate:
- **Durable (any `type:"capture"` row — i.e. every fresh capture and every retyped legacy survivor)** → `rewrite_memory(id, { type, typeFields?, … })` **alone**. This is mandatory: it assigns the real type, structures the body, and promotes to `active` in one op. `confirm_memory` must **not** be called (it would not change `type`, leaving the forbidden `active+capture` state).
- Durable and **already a real, correctly-typed clean statement** (only possible for a candidate whose `type` is *not* `capture` — in practice none, since both fresh and retyped-legacy survivors are `capture`; reserved for hypothetical externally-created typed candidates) → `confirm_memory(id)` **alone** → `active`.
- Not durable → `deprecate_memory(id, reason)` → rejected.
- Unsure → leave it; ages out via the existing 90d cleanup loop.

Net: for this feature's flow the terminal keep-action is **always `rewrite_memory`**; `confirm_memory`-alone is effectively unreachable for captures and is documented only to make the mutual-exclusion rule complete.

**Surfacing (dual):**
- Rehydrate briefing gains a dedicated section `## Captures pending confirmation — N`, separate from the existing `## Pending review … cleanup` section, with the `review_pending_captures` → `rewrite`/`confirm`/`deprecate` workflow and the precision framing ("most extracted captures are noise; keep only durable, generalizable rules").
- `captureSession` (session-end) stages survivors immediately, so they are present when the next session rehydrates and the nudge fires while a fresh session can still resolve transcript windows.

## Legacy triage migration

One-shot, idempotent, lazy on first rehydrate per repo after upgrade (mirrors `runRepoKeyMigrationIfNeeded` + its sentinel):

- Select all `source='extracted' AND status='candidate'`.
- Run each body through the new structural gate. Structural-noise → `deprecateMemory(id, "legacy triage: structural noise")` (auditable, recoverable, ages out — not hard-deleted).
- Survivors stay `candidate` **and are retyped to `type:"capture"`** (via the registry-validated path). Their old inferred type was an unreliable regex guess we explicitly distrust, and retyping makes the unreviewed set uniform: fresh and legacy survivors are indistinguishable to the queue, briefing, and browser — all `source='extracted' AND status='candidate' AND type='capture'`. The `review_pending_captures` predicate's source of truth remains `source='extracted' AND status='candidate'`; `type='capture'` is now the consistent label across that whole set, not just fresh rows. Legacy survivors usually resolve to `context.kind: "body-only"` (sessions pruned); the agent judges from the body and assigns the real type via `rewrite_memory`.
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
| Gate end-to-end | Fixture evidence layer → only survivors created, each `type:"capture"` `status:"candidate"`; `createMemory` accepts `capture` (registry seed present); assert confidence/`re_extract_count` no longer bumps or promotes `source:"extracted"` | unit |
| `capture` type + trust | `capture` is a valid registry type with no required sections; never surfaced by `surface.ts` (active-only); 0.5×-weighted in `recall_memory`; `rewrite_memory` reassigns `capture`→real type + promotes→active in one op; no `type='capture'` filter added to recall | unit (reuse surface/retrieve fixtures) |
| Registry seed migration | persisted `types.json` at old version lacking `capture` → after load/ensure, `capture` present + `version==REGISTRY_VERSION`; user-defined types untouched; idempotent on re-run; brand-new repo seeded directly | unit |
| `signalScore` | pure function of body, deterministic; recomputed at query time (asserted: no DB column / frontmatter field written); orders the queue; never gates creation | unit |
| `review_pending_captures` | predicate selects only unconfirmed extracted candidates (excludes confirmed/deprecated); `context` fallback hierarchy exercised at each level (transcript-window / evidence-pair / body-only) incl. `context.kind` correctness; limit/order by recomputed `signalScore`; read-only (no get_count bump) | unit, fixture index + history (session present, transcript pruned, pre-v2 no-snippet, fully pruned) |
| Confirm loop | `rewrite_memory` alone → active; `confirm_memory` alone → active; calling both on one id throws (asserted); `deprecate_memory` → rejected (reuse existing lifecycle tests) | unit |
| Legacy triage migration | structural-noise→deprecated; keepers→candidate **and retyped `type:"capture"`** + in queue; runs after registry seed-merge (ordering); idempotent re-run no-ops; sentinel honored; corrupt index aborts without sentinel | integration, tmpdir cache w/ seeded legacy candidates at varied old types |
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
- **Ordering hazard: registry seed-merge must run before any `type:"capture"` write** — if the gate or legacy triage stamps `capture` before the registry migration has merged it, `createMemory`/`rewriteMemory` validation throws `unregistered type: capture`. Mitigation: the registry seed-merge runs at registry load/ensure (the path every memory write already funnels through `ensureRegistry`/`readRegistry`), so it is guaranteed to have applied before the first `capture` write in the same process; the legacy-triage integration test explicitly covers "old registry + extracted candidates → migrate registry first, then triage" ordering.

## Open questions

None at design freeze. Gate strategy (structural-only), LLM source (calling agent via MCP), confirm flow (reuse candidate lifecycle + new read tool + dual surfacing), legacy handling (re-gate → agent queue, deprecate not delete), and confidence-promotion removal are all decided and data-validated.

## File map

```
src/
  lib/memory/
    extract.ts              (rewrite: structural gate; drop positive-classifier + extracted confidence-promotion; add signalScore; stamp type:"capture")
    registry.ts             (+ "capture" built-in seed type; REGISTRY_VERSION→2; idempotent version<N seed-merge migration on load/ensure — union, preserves user types)
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
