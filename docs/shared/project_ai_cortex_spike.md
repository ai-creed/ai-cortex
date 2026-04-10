# ai-cortex — Project Spike

## Purpose

This document captures the current high-level intention for `ai-cortex` before
any implementation work starts.

It is not a detailed implementation plan.

It exists to align on:

- what the product is
- what the MVP is not
- the preferred V1 shape
- the technical bets that must be validated early

## Problem

New AI-agent sessions start with too little reliable project context.

When working in the same repository across many sessions, the agent often has to
re-read the same files, rediscover the same structure, and rebuild the same
mental model from scratch.

This causes:

- slower session startup
- unnecessary broad repo scans
- repeated token waste
- inconsistent architecture understanding between sessions
- worse performance in large repositories

The problem is not that the agent knows nothing.

The problem is that the agent has no fast, durable, project-specific cached map
to start from.

## Product Intention

`ai-cortex` is intended to be a local project rehydration engine for AI agents.

The product should make it easy to:

- build a cached structural view of a repository
- refresh that cache without broad rescans every time
- generate a compact rehydration briefing for a new agent session
- suggest likely relevant files or modules for a task
- keep all of this outside the target repository

The product is not a cloud service, team memory system, or repo-writing
metadata layer.

## Product Framing

The core object is the `repo knowledge cache`.

A repo knowledge cache represents the current durable understanding of one local
repository and acts as a container for:

- code structure
- project documentation signals
- file and module relationships
- repo-level summaries needed for quick rehydration

For MVP, this is the correct framing:

**A local cache-and-query engine that helps agents rehydrate project knowledge quickly and consistently.**

The primary value is not generic search.

The primary value is fast, useful session startup.

## MVP Definition

The MVP should focus on three things:

1. Local indexing of one repository
2. Rehydration output for new agent sessions
3. Relevant file or module suggestion for a task

If those three parts work well together, the core product is validated.

The first proof can target one real repository, but the product model should not
depend on repo-specific assumptions.

## MVP Capabilities

The MVP should support:

- indexing one local repository into tool-owned local storage
- reading code structure from TypeScript and JavaScript repositories
- reading project docs as a first-class signal
- returning a compact text briefing for agent startup
- returning structured JSON for downstream `ai-*` integrations
- suggesting likely relevant files or modules with short reasons
- refreshing stale parts of the cache during `rehydrate`

The MVP should not require:

- repo writes
- manual user annotation
- background daemons
- real-time file watchers
- cloud services

## Rehydration Surface For V1

The primary command in V1 should be `rehydrate`.

Its job is to:

- load the existing cache if present
- detect whether important parts are stale
- refresh enough of the cache to stay useful
- emit an agent-ready summary of the project

The output should help answer:

- what kind of project is this?
- what are the main subsystems?
- where should the agent likely look first?
- what docs or files are most relevant to the current task?

## Suggest Surface For V1

The `suggest` command should stay intentionally narrow.

Its job is not to solve the task.

Its job is to return likely relevant files or modules, with short reasons, so an
agent can target its next reads instead of broad scanning.

V1 should favor relevance and explanation over fake precision or deep ranking
complexity.

## Input Scope For V1

The initial indexing input should be:

- repository file structure
- TypeScript or JavaScript imports and module boundaries
- package metadata
- project docs such as `README`, planning docs, and architecture notes

This is enough to prove whether the product can generate useful rehydration
without needing full language intelligence.

## Storage Model For V1

All cache artifacts should live outside the target repository.

This is a hard product constraint.

The target repository must remain:

- clean
- publish-safe
- free of app-owned metadata files

The cache should behave like local tool state, not project source.

## Why This Product Is Plausible

This product is technically plausible because:

- the needed inputs already exist locally
- useful rehydration does not require perfect understanding of every file
- most early value comes from structure and docs, not full semantic analysis
- explicit indexing plus targeted refresh is much simpler than a live graph platform
- the output quality can be evaluated directly against real agent tasks

## Early Technical Bets

The riskiest bets that should be validated early are:

- a local cache can reduce startup cost meaningfully versus cold scanning
- structure plus docs are enough to answer basic architecture questions
- file suggestion can be useful without a full semantic engine
- cache refresh can stay cheap enough for repeated use on real repos
- the same core can later be embedded into the `ai-*` ecosystem without being rewritten

## Proof Criteria

`ai-cortex` is worth continuing only if it can prove all of the following on at
least one real repository:

- architecture questions can often be answered from cache
- likely relevant files can be suggested with short reasons
- `rehydrate` is measurably faster than a cold broad scan

The proof should be credible for larger repositories, even if V1 is first tuned
on a smaller or medium-sized repo.

## Non-Goals For MVP

Do not expand V1 into:

- collaborative knowledge sharing
- manual note-taking or annotation systems
- general-purpose code search
- code editing workflows
- language-complete understanding across every stack
- live daemon or watcher infrastructure

Those can be revisited only after the first personal MVP proves useful.
