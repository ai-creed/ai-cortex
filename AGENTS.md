# AGENTS

## Project Summary

- `ai-cortex` is a local-first intelligence layer for AI agents — fast project rehydration, file discovery, call-graph awareness, captured session history, and a memory layer that records project rules and surfaces them at edit time.
- Architecture is three-layer: structural (rehydrate / suggest / blast-radius), continuity (history + memory), and integration (MCP + briefing + adoption tooling).
- All persistent state lives under `~/.cache/ai-cortex/`. ai-cortex MUST NOT write to user repository files.

## Source Of Truth

- Tracked architecture and product decisions live in `docs/superpowers/specs/`.
- Local execution plans live in `docs/superpowers/plans/`.
- `docs/superpowers/plans/` is git-ignored and local-only. Do not commit or re-track files from that directory.
- User-facing docs: `README.md` plus the curated hierarchy under `docs/` (`getting-started`, `concepts`, `guides`, `reference`, `architecture`, and `roadmap`).

## Repo Layout

- `src/cli.ts`: CLI entrypoint.
- `src/version.ts`: canonical version source. Kept in lockstep with `package.json` by `scripts/release.sh`.
- `src/lib/`: core library (indexer, retrievers, briefing, update-notifier, migration-notifier).
- `src/lib/history/`: session-history capture + hook installation.
- `src/lib/memory/`: memory layer (lifecycle, recall, scope match, surface hook, briefing digests).
- `src/lib/stats/`: telemetry sinks + readers used by the stats TUI and CLI report.
- `src/mcp/server.ts`: MCP server with the agent-facing tool surface.
- `tests/unit/`, `tests/integration/`: vitest test suites.
- `scripts/release.sh`, `scripts/lib/release-headline.ts`: release tooling.

## Memory Layer Self-Use

- This project uses its own memory layer. Project-scoped memories surface during edits via the `PreToolUse` hook and the rehydration briefing.
- **Do not put scars, gotchas, or recurring lessons in this file.** Record them as memories via `record_memory` so they surface only when relevant (and don't bloat every agent's context).
- Cardinal pattern: `recall_memory` is browse-only and does not signal usage; `get_memory(id)` is the consult signal that drives cleanup eligibility.

## Workflow Rules

- Use brainstorming → spec → plan → implement for non-trivial features. Specs live in `docs/superpowers/specs/`; plans in `docs/superpowers/plans/`.
- Prefer subagent-driven implementation (`superpowers:subagent-driven-development`) for multi-task plans — fresh subagent per task with two-stage review (spec compliance, then code quality).
- Use a feature branch for plan execution when isolation matters; small fixes can go directly on `master`.
- Commit the new `CHANGELOG.md` entry **before** running `scripts/release.sh` — the release script bumps `package.json` + `src/version.ts` but does not touch `CHANGELOG.md`.

## Verification Rules

Before tagging or claiming a feature complete, run all of:

- `CI=true pnpm test` — local `pnpm test` is not equivalent to CI; production code in this repo gates on `process.env.CI`.
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build` — `tests/integration/cli.test.ts` spawns `dist/src/cli.js` and only rebuilds when missing, not when stale.

If verification is not clean, the work is not complete. Report real failures clearly instead of hand-waving them.

## Release Process

- `scripts/release.sh <version>` handles the version bump, `src/version.ts` lockstep, `aiCortex.releaseHeadline` prompt, commit, tag, and push.
- Non-interactive (CI / unattended): set `AI_CORTEX_RELEASE_HEADLINE='<value>'`. Use `'-'` to clear the previous headline.
- GitHub CD (`.github/workflows/publish.yml`) publishes to npm on tag push. There is no in-script `npm publish`.

## Documentation Policy

- Update tracked specs when architecture decisions change.
- Update `README.md` and the relevant `docs/` page for user-facing changes.
- `CHANGELOG.md` follows a narrative style: intro paragraph + `### Added / Changed / Fixed / Internal / Known limitations` sections + bold-lead-phrase bullets with WHY/HOW prose. Do not write flat conventional-commit listings.
- Keep this file procedural and stable. Do not duplicate spec content here; refer to specs and reference docs.

## No-Repo-Writes Principle

- ai-cortex MUST NOT create or modify any file inside a target repository. All state lives under `~/.cache/ai-cortex/`.
- Project-owner files in user repos (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `PROJECT_INDEX.md`, etc.) are off-limits.
- Hook installation under `~/.claude/settings.json` and `~/.codex/config.toml` is the explicit exception — those are user-owned config (not repo-owned), and the user opts in via `ai-cortex history install-hooks`.
