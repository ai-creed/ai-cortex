# ai-cortex

`ai-cortex` is a local project rehydration engine for AI agents.

Its purpose is to give new agent sessions fast, consistent cached knowledge
about a project without broad repo scans or writes into the target repository.

## Status

Phases 0–4 complete. Personal MVP delivered.

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Plausibility spike | complete |
| 1 | Core indexing spine | complete |
| 2 | Rehydration flow | complete |
| 3 | Suggest flow | complete |
| 4 | Hardening for real repos | complete |

## Commands

```
ai-cortex index [path]                    # Index a repo into local cache
ai-cortex index --refresh [path]          # Force full reindex

ai-cortex rehydrate [path]                # Generate briefing from cache
ai-cortex rehydrate --stale [path]        # Use cached data even if stale
ai-cortex rehydrate --json [path]         # Machine-readable output

ai-cortex suggest "<task>" [path]         # Rank relevant files for a task
ai-cortex suggest "<task>" --from <file>  # Anchor ranking to a known file
ai-cortex suggest "<task>" --limit <n>    # Return at most n results (default 5)
ai-cortex suggest "<task>" --stale        # Use cached data even if stale
ai-cortex suggest "<task>" --json         # Machine-readable output
```

## Library API

```ts
import { indexRepo, rehydrateRepo, suggestRepo } from "ai-cortex";

const result = suggestRepo("/path/to/repo", "persistence layer");
// { task, from, cacheStatus, results: [{ path, kind, score, reason }] }
```

## Primary references

- `docs/shared/product_brief.md`
- `docs/shared/high_level_plan.md`
- `docs/shared/project_ai_cortex_spike.md`
