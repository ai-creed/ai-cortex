# ai-cortex — High-Level Plan

## Planning Intent

This document is a high-level delivery plan for the current V1 direction.

It is not a task-by-task implementation checklist yet.

The plan assumes:

- local-first execution
- no writes into target repositories
- TypeScript and JavaScript as the first-class language target
- one real repo proof first, with a path to many repos later
- `rehydrate` as the primary user flow
- CLI plus library delivery surface

The goal is to move from product plausibility to a useful personal MVP without
overcommitting to premature infrastructure.

## Delivery Strategy

The project should be delivered in stages with explicit validation gates.

The sequence should be:

1. Prove the core rehydration thesis on one real repository
2. Build a durable local indexing and query spine
3. Make `rehydrate` useful enough to replace broad startup scans
4. Add `suggest` as a practical targeting tool for agent workflows
5. Harden for larger repos before expanding language and ecosystem scope

## Proposed Timeline

This is a realistic high-level timeline for a focused solo build:

- Phase 0: 3 to 5 days
- Phase 1: 4 to 6 days
- Phase 2: 4 to 6 days
- Phase 3: 3 to 5 days
- Phase 4: 4 to 7 days

That puts the first useful personal MVP in roughly 3 to 4 weeks, depending on
how hard stale refresh and repo-scale performance fight back during the proof.

## Phase 0 — Plausibility Spike

**Goal:** Validate that cached rehydration is worth building before deeper
product work.

**Focus areas:**

- repository inspection inputs
- simple local cache shape
- cold-scan versus cached-briefing comparison
- proof on one real repository

**Deliverables:**

- minimal local indexing experiment for one repo
- baseline measurement for cold startup context gathering
- cached rehydration experiment for the same repo
- example architecture questions answered from cache
- example file targeting suggestions produced from cached knowledge

**Success gate:**

- cached rehydration is materially faster than broad cold scanning
- output is useful enough to orient a new agent session
- the proof looks credible enough to justify productizing the approach

**Failure signals:**

- cached output is too vague to guide an agent
- refresh cost approaches cold-scan cost too quickly
- suggestion quality depends on too much manual tuning

## Phase 1 — Core Indexing Spine

**Goal:** Establish the durable product core without overbuilding ranking or
language support.

**Focus areas:**

- repo identity and storage model
- local cache lifecycle
- TypeScript and JavaScript structure extraction
- doc ingestion

**Deliverables:**

- core library structure
- repo-scoped local cache in tool-owned storage
- indexing pipeline for file tree, package metadata, imports, and docs
- stable internal representation sufficient for rehydration queries
- CLI entrypoint for `index`

**Outcome:**

The codebase should now have a stable indexing backbone so rehydration features
do not get tangled with one-off spike logic.

## Phase 2 — Rehydration Flow

**Goal:** Make `rehydrate` genuinely useful for starting a new agent session.

**Focus areas:**

- stale detection
- targeted refresh
- compact text briefing
- structured JSON output

**Deliverables:**

- `rehydrate` command in CLI and library
- text output suitable for direct agent prompting
- JSON output suitable for later `ai-*` integration
- concise repo summary focused on orientation and next reads

**Success gate:**

- a new session can start from `rehydrate` output instead of broad repo scan for
  common project-orientation tasks
- output stays compact enough to be practical in agent prompts

## Phase 3 — Suggest Flow

**Goal:** Help agents jump toward likely relevant files instead of searching
widely.

**Focus areas:**

- task-to-file targeting
- short explanation strings
- practical ranking heuristics

**Deliverables:**

- `suggest` command in CLI and library
- likely relevant files or modules returned with short reasons
- enough relevance to support common “where should I look first?” tasks

**Success gate:**

- suggestions improve first-step targeting often enough to change workflow
- explanations are short, concrete, and believable

## Phase 4 — Hardening For Real Repos

**Goal:** Make the product dependable enough for repeated personal use on larger
repositories.

**Focus areas:**

- performance on larger repos
- refresh cost control
- cache invalidation behavior
- practical failure handling

**Deliverables:**

- acceptable rehydration latency on at least one substantial real repo
- clearer stale-versus-fresh behavior
- better handling for missing docs, noisy trees, or weak import signals
- repeatable CLI behavior suitable for embedding into `ai-*` tools

**Exit condition:**

The user prefers starting at least some new agent sessions through
`ai-cortex rehydrate` instead of broad manual repo scanning.

## Deferred Until After MVP

These should stay out of the initial delivery unless real usage proves they are
urgently needed:

- real-time watching or daemonized indexing
- cloud sync
- team-shared caches
- manual annotations
- non-TS/JS language depth beyond light experiments
- broad platform ambitions beyond rehydration and suggestion
