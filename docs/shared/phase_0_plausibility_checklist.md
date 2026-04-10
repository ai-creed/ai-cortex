# ai-cortex — Phase 0 Plausibility Checklist

## Purpose

This document defines the concrete proof needed before `ai-cortex` should
expand into a fuller implementation effort.

Phase 0 is not about polishing architecture.

It is about proving that cached project rehydration is materially useful on a
real repository.

## Phase 0 Goal

Demonstrate that `ai-cortex` can build enough cached project knowledge to help a
new agent session start faster and more consistently than a broad cold scan.

## Hard Questions To Answer

Phase 0 must answer all of these:

1. Can cached structure plus docs produce a useful project briefing?
2. Can that briefing be generated materially faster than a broad cold scan?
3. Can the same cached knowledge suggest likely relevant files for a task?
4. Can the approach stay credible on a substantial real repository?

If the answer to any of these is effectively no, the product thesis is weak.

## Test Conditions

Phase 0 should use at least one real repository.

The proof repository should ideally have:

- active ongoing development
- meaningful internal structure
- enough docs to test doc-assisted rehydration
- enough size that broad rescanning is not trivial

`ai-14all` is a valid candidate, but the proof should not depend on
`ai-14all`-specific assumptions.

## Inputs Allowed In Phase 0

Phase 0 should only depend on:

- repository file tree
- TypeScript or JavaScript source structure
- import relationships
- package metadata
- project docs such as `README`, planning docs, and architecture notes

Phase 0 should not depend on:

- manual annotations
- repo writes
- background services
- cloud infrastructure
- fine-grained language intelligence beyond the initial target stack

## Baseline Comparison

Phase 0 needs a baseline.

That baseline is the cost of cold project orientation without `ai-cortex`.

Measure at least:

- how long it takes to gather orientation context by broad scanning
- how much repo surface gets touched during that scan
- whether the resulting orientation is consistent enough to answer basic project questions

The point is not perfect benchmarking.

The point is proving that cached rehydration changes workflow materially.

## Required Experiments

### Experiment 1 — Cached Rehydration Briefing

Build a minimal cache from one real repository and produce a compact rehydration
briefing.

That briefing should help a fresh agent answer:

- what kind of project this is
- what the major subsystems are
- what docs matter first
- where the agent should likely start reading

**Pass condition:**

The output is compact, coherent, and practically useful for a fresh session.

### Experiment 2 — Speed Comparison

Compare a cold orientation pass against cached rehydration.

The exact benchmark method can stay lightweight, but it should show:

- cold orientation time
- cached rehydration time
- the size of the gap

**Pass condition:**

Cached rehydration is materially faster in a way that would change real usage.

### Experiment 3 — Architecture Question Check

Ask a small set of architecture-oriented questions using only cached output.

Example question types:

- what are the main subsystems?
- where is the backend boundary?
- where are shared models defined?
- which docs best explain current product direction?

**Pass condition:**

Answers are usually correct enough to orient work without broad repo scanning.

### Experiment 4 — File Suggestion Check

Use cached knowledge to suggest likely relevant files for concrete tasks.

Example task types:

- add a new UI flow
- inspect persistence logic
- trace worktree lifecycle behavior
- find where repo-level models live

**Pass condition:**

Suggestions point near the right files often enough to improve first-step targeting.

### Experiment 5 — Scale Credibility Check

Run the same basic approach on a more substantial repository, or on a slice of
one, to ensure the product thesis does not collapse outside a small demo.

This does not require perfect support for every repo.

It requires credible evidence that the approach can scale beyond toy cases.

**Pass condition:**

The approach remains useful and does not degenerate into near-full rescans.

## Evaluation Criteria

Phase 0 should evaluate output on four dimensions:

### 1. Speed

- Is `rehydrate` noticeably faster than cold orientation?
- Is refresh cheaper than rebuilding from scratch?

### 2. Utility

- Does the cached briefing genuinely help a new session start?
- Would you choose it over broad manual scanning for some real tasks?

### 3. Accuracy Enough To Be Useful

- Are the main architectural claims mostly right?
- Are suggested files usually plausible first reads?

### 4. Operational Simplicity

- Can the product stay local-only?
- Can it avoid writing into target repos?
- Can the workflow remain invisible to the user?

## Failure Signals

Phase 0 should be treated as a warning if any of these happen:

- the briefing is too vague to guide a session
- suggested files are noisy or obviously wrong too often
- refresh cost is close to cold-scan cost
- usefulness depends on hand-curated repo knowledge
- the product starts needing daemon-style complexity too early

## Exit Criteria

Phase 0 is successful only if all of the following are true:

- cached rehydration is materially faster than broad cold scanning
- the briefing is useful enough to orient a fresh session
- cached knowledge can answer basic architecture questions
- file suggestions are useful often enough to change workflow
- the proof looks credible for at least one real repo beyond a toy example

If these are met, `ai-cortex` has earned a deeper architecture and implementation phase.

If these are not met, the product direction should be reconsidered before more build-out.
