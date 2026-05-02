# ai-cortex Product Brief

## One Line

`ai-cortex` builds local cached project knowledge for agents, so new sessions can
rehydrate fast and consistently without broad repo scans or repo pollution.

## User

- Day 1 user: solo AI-heavy developer
- Later fit: other tools in the `ai-*` ecosystem

## Core Problem

New agent sessions start with little reliable project context.

Agents must re-scan repositories, rediscover structure, and re-read the same
docs. This wastes time, tokens, and consistency, especially in large repos.

## Job To Be Done

When starting a new agent session on a project, provide enough cached project
knowledge for the agent to become useful quickly and consistently, without a
full repo scan every time.

## Product Goal

Make project rehydration fast, repeatable, and good enough to answer
architecture questions and jump to likely relevant files from cache.

## V1 Scope

- local-only
- one real repo proof first, but the product model should support many repos later
- TypeScript and JavaScript first-class
- C and C++ as later adapter targets
- knowledge inputs: code structure plus project docs
- output forms: compact text briefing plus structured JSON
- delivery surfaces: library plus CLI
- primary command: `rehydrate`
- secondary commands: `index`, `suggest`

## V1 Non-Goals

- no writes into the target repo
- no user-managed notes or annotations
- no cloud sync
- no team or shared memory
- no editor or IDE workflow expansion
- no real-time watcher or index daemon
- no full semantic understanding of every language
- no generic code search engine ambitions in the MVP

## Core User Value

- faster new-session startup
- more consistent agent context
- better file targeting
- less repeated rediscovery of the same project structure

## Primary Flows

### `index`

Build a local cache for a repo.

### `rehydrate`

Load cache, refresh stale parts, and return an agent-ready project briefing.

This is the primary flow for V1.

### `suggest`

Return likely relevant files or modules for a task, with short reasons.

## Success Criteria

- agent can answer repo architecture questions from cache
- agent can suggest likely relevant files or modules with short reasons
- `rehydrate` is measurably faster than a cold broad repo scan
- works on at least one real repo, with credibility toward multi-thousand-file repos

## Freshness Model

- explicit `index` is supported
- `rehydrate` auto-refreshes stale parts before answering
- V1 does not promise near-real-time freshness

## Storage Model

- cache lives outside the target repo
- storage is tool-owned and local-only
- target repos stay clean and publish-safe

## Why This Product Is Plausible

- the needed inputs already exist locally: file tree, imports, docs, and package metadata
- rehydration does not require perfect understanding of every file
- useful agent startup can come from partial structured knowledge
- local cache plus targeted refresh is much simpler than a full always-on graph platform

## MVP Definition

Given a repo path, `ai-cortex` can:

- build a local cache from code structure and docs
- produce a compact project briefing for a new agent session
- suggest relevant files for a user task
- refresh stale cache enough to stay practical

## Roadmap

1. Prove value on one real repo with `index`, `rehydrate`, and `suggest`.
2. Harden stale refresh and performance for larger repos.
3. Add multi-repo management.
4. Add language adapters beyond TypeScript and JavaScript.
5. Integrate cleanly into `ai-*` apps and session flows.

## Key Risks

- cache may know structure but miss intent and rationale
- large repos may need careful scope trimming to stay fast
- suggestion quality may degrade with weak docs or noisy module structure
- C and C++ support is materially harder than TypeScript and JavaScript

## Product Thesis

Agents do not need a full repo scan every session.

Agents need a good cached project map plus a small live refresh.

`ai-cortex` exists to provide that map.
