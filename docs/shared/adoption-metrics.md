# Adoption Metrics — How to Read Them

The numbers shown by `ai-cortex stats sessions` and the stats TUI **Sessions** tab (Phase 11).

These are **diagnostic dials, not a verdict.** They tell you which lever to pull when something looks off — they do not say the tool is "passing" or "failing." Hard health thresholds (✓/✗) are deliberately deferred until enough real usage establishes baselines (see *Calibration debt*, below).

---

## Glossary

| Metric | What it measures | How to read it |
|---|---|---|
| **`sessionCount`** | Distinct `session_id`s seen in the window, including the `(unattributed)` bucket. | A sanity check, not performance. `0` → telemetry/hooks aren't firing or the harness didn't expose a session id (compare to `unattributedShare`). Small + fresh install → probably need to restart the harness so the new MCP server registers. |
| **`memoryUsed %`** | Fraction of sessions where the agent did `get_memory ≥ 1` OR `record_memory ≥ 1`. *Recall alone does not count* — recall is browse; get is the use signal (the cardinal pattern). | How many sessions actually *touched* memory. Low ≠ broken: many sessions legitimately don't need memory. **Persistently very low while you know rules apply** → memory layer isn't reaching the agent — check `install-prompt-guide`, hooks installed, and that `recall_memory`/`get_memory` are visible in the agent's tool list. |
| **`recall→get %`** | Of sessions with ≥1 `recall_memory`, the fraction that then did `get_memory` with `ts > firstRecall ts` in the same session. | The **cardinal-pattern signal.** Browse → commit conversion. High → recalls convert to applied rules. Low → agent finds candidates but doesn't commit (irrelevant titles, noisy candidates, or the agent isn't following recall→get). This is the single highest-information number; if you only watch one dial, watch this. |
| **`surface→get %`** | Of sessions with ≥1 edit-time surfacing, the fraction with a `get_memory` whose `ts` is after the first surfacing. Coarse v1: *any* later `get_memory` counts (not specifically the surfaced ids — precise correlation is deferred, see spec §6/§12). | v0.9.0 effectiveness signal. High → the `PreToolUse` hook actually nudges the agent to consult. Low → surfacings happen but the agent doesn't bite (likely `scopeFiles` too broad → matches feel irrelevant; or the surface-context line is being ignored). |
| **`extract→cleanup %`** | `Σ cleanup actions (rewrite_memory + deprecate_memory + confirm_memory) ÷ Σ extract_session.result_count` in the window. Window/project-level — extraction happens post-session, cleanup happens in later sessions, so this is a rate, not a cohort. | Triage rate. Low → candidate store bloats over time, store gets noisy, recall precision degrades. High → cleanup loop is alive. Lags extraction in time, so a moderate value (not 100%) is normal — but a steadily-dropping value is a debt signal. |
| **`unattributedShare`** | Fraction of windowed `tool_calls` rows with NULL `session_id`. | **Honesty/coverage signal, not a performance metric.** High → either pre-v3 history dominates, or the harness doesn't expose session id to the MCP process — so every other number above is a weaker estimate (events bucketed under `(unattributed)`). Should drop over the next 1–2 weeks as new attributed events accumulate. Compare every other percentage *in light of this share*: a `recall→get` of 80% computed from 90% unattributed rows means "of the 10% we can attribute, 80% converted" — directionally useful, not definitive. |

---

## Combined read — patterns to look for

No single number is a verdict. Look at the *pattern* across three or four dials.

### Healthy
`recall→get` substantial **and** `surface→get` non-trivial **and** `memoryUsed` reflects what you'd expect from the kind of work the sessions did **and** `unattributedShare` is low. The agent finds memories, applies them, and the edit-time hook nudges consultation.

### Dormant memory layer
`memoryUsed ≈ 0` across sessions where rules clearly apply.
→ The layer exists but isn't reaching the agent. Check: `install-prompt-guide` written into `CLAUDE.md`/`AGENTS.md`; hooks installed (`ai-cortex history install-hooks`); the MCP server actually registered (`claude mcp get ai-cortex`); the agent's tool list includes `recall_memory`/`get_memory`.

### Browse-but-don't-apply
`recall→get` is low while `memoryUsed` is non-zero.
→ The agent finds memories, judges them irrelevant. Likely causes: noisy candidate titles (many `type: capture` items rotting in `status: candidate`); overly broad scope on real rules; recall returning low-signal hits because rules haven't been rewritten into rule cards. Action: run `list_memories_pending_rewrite` triage; review titles; tighten `scopeFiles`.

### Surface-noise
`surface→get ≈ 0` with many surfacings.
→ File-scope matches are firing but feel irrelevant to the agent. Action: review the `scopeFiles` glob patterns on your memories — `src/**` is almost certainly too broad; prefer literal paths or narrow globs. Consider deprecating memories whose scope doesn't match where the rule actually applies.

### Triage debt
`extract→cleanup %` near 0 with a growing candidate pool.
→ The extractor produces candidates faster than they're triaged. Action: dispatch `review_pending_captures` more often, or accept that the extractor is too noisy for your repo and tune (Phase 15 is the deferred fix — LLM-based extractor in a user subagent).

### Low confidence in everything
`unattributedShare` high (say > 50%).
→ The numbers above are estimates from a minority of attributed events. Either you're early in a fresh install (give it 1–2 weeks of new sessions) or the harness isn't exposing session id to the MCP process. Until this drops, treat all other percentages as directional, not definitive.

---

## Calibration debt — why no ✓/✗ in the report

Hard thresholds (e.g. "`recall→get < 30% → ✗`") are intentionally absent. Healthy ranges depend on:

- **Project age / mix.** A fresh repo with few memories will naturally show low `memoryUsed` regardless of agent behavior.
- **Agent vendor / model.** Some agents follow recall→get better than others by default.
- **Work mix.** Greenfield code, deep refactors, and routine edits exercise memory differently.
- **Surfacing scope quality.** Tight `scopeFiles` raises both `surface→get` precision and `recall→get` over time.

Premature thresholds would be confidently wrong for many real configurations. The plan is to gather usage data over the next few weeks of Phase 11 in production, then add empirically-grounded health captions in a follow-up (or move to Phase 12's closed feedback loop, which measures observed utility rather than usage). Until then, this doc is the interpretation layer.

---

## See also

- High-level plan, Phase 11 — `docs/shared/high_level_plan.md`
- KNOWN_LIMITATIONS — *Adoption telemetry* section
- Design spec — `docs/superpowers/specs/2026-05-19-adoption-telemetry-design.md` (metric definitions in §6)
- Memory layer guide — `MEMORY_LAYER.md` (the cardinal `recall_memory → get_memory` pattern that several of these dials measure)
