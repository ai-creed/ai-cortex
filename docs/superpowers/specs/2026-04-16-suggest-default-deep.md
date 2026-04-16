# ADR: Default `suggest_files` to deep mode

**Date:** 2026-04-16
**Status:** Accepted
**Supersedes:** The original two-tier design in `2026-04-15-ranker-fast-deep-design.md` §7.1 where `suggest_files` used fast mode and `suggest_files_deep` was the escalation path.

## Context

The target-repo benchmark (`docs/shared/ranker_target-repo_benchmark.md`) showed that on verbatim PR-title queries against a large real-world codebase (~8K files):

| Mode | hit@5 | avg durationMs | avg output bytes |
|---|---:|---:|---:|
| fast | **0 %** | 1 853 | 1 027 |
| deep | **20 %** | 2 078 | 1 503 |

Deep is strictly better than fast on every measured dimension except ~200ms extra latency. The two-step "try fast, check escalation hint, call deep" workflow wastes one round-trip for zero benefit.

## Decision

**`suggest_files` now defaults to `mode: "deep"` internally.**

- The MCP tool `suggest_files` invokes the deep ranker (trigram fuzzy + content scan) instead of the fast ranker.
- The MCP tool `suggest_files_deep` remains available for callers that want explicit control over `poolSize`.
- The CLI `suggest` command retains fast as default; `suggest-deep` is the deep CLI entry point.
- The library API `suggestRepo()` still accepts `mode: "fast" | "deep"` — no default change at the library level.

## Consequences

- **Agents get better results without needing to know about modes.** One tool call, best available ranking.
- **No escalation hint in `suggest_files` output.** Deep mode doesn't emit one since there's nothing to escalate to.
- **~200ms additional latency per call.** Acceptable tradeoff for 20% vs 0% hit rate.
- **`suggest_files_deep` is kept** for backward compatibility and explicit `poolSize` control. Not deprecated.
- **CLI unchanged** — `suggest` stays fast, `suggest-deep` stays deep. Power users can choose.

## Alternatives considered

1. **Merge tools into one.** Rejected — would require removing `suggest_files_deep`, undoing recent work, and breaking any existing agent configurations.
2. **Change library default.** Rejected — library callers may need sub-10ms latency for scripting. Keep explicit at that level.
3. **Document-only, no code change.** Rejected — the benchmark data is clear enough to act on.
