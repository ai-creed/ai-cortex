# Benchmarking Reference

Use this page when measuring ai-cortex performance or ranking quality.

The benchmark suite runs locally. It measures latency regressions, SLOs, and retrieval quality against real repositories and committed fixtures.

## Quick Start

Run all benchmark suites:

```bash
pnpm bench
```

Fast smoke run:

```bash
pnpm bench --fast
```

Performance only:

```bash
pnpm bench:perf
```

Quality only:

```bash
pnpm bench:quality
```

## CLI Flags

| Flag | Description |
|---|---|
| `--suite perf|quality` | Run only one suite. Default is both. |
| `--repo <name>` | Filter to a single repo by name, such as `ai-cortex`. |
| `--fast` | Reduce iterations for quick smoke tests. |
| `--json` | Write full results to `benchmarks/results.json`. |
| `--update-baseline` | Save current p50 values to `benchmarks/baselines.json`. |

## Performance Suite

The performance suite measures five scenarios across discovered repos:

| Scenario | Measures | Cache precondition |
|---|---|---|
| `index:cold` | Full indexing from scratch | Cache cleared before each run |
| `rehydrate:warm` | Rehydration with valid cache | Cache pre-built |
| `rehydrate:stale` | Incremental reindex on dirty worktree | Clean cache built, then marker file added |
| `suggest:warm` | File suggestion ranking | Cache pre-built |
| `blastRadius:warm` | Call graph BFS query | Cache and target captured in setup |

Each scenario reports p50, p95, min, and max timings.

Regression detection compares current p50 against a saved baseline:

- more than 10 percent slower: warning
- more than 20 percent slower: failure
- no baseline: skipped with note

SLO enforcement checks current p50 against per-scenario, per-size-bucket thresholds. A result can pass regression detection and still fail an SLO.

## Quality Suite

The quality suite runs against a committed synthetic TypeScript repo:

```text
benchmarks/fixtures/synthetic/repo/
```

It checks:

- suggest precision and recall
- blast-radius expected caller tuples
- relative ranking assertions on real repos

The synthetic fixture includes known call chains across auth, API, database, and utility modules.

## Baselines

Baselines are per-machine and gitignored.

On a fresh clone:

```bash
cp benchmarks/baselines.example.json benchmarks/baselines.json
pnpm bench --update-baseline
pnpm bench:perf
```

Re-run with `--update-baseline` after intentional performance changes.

## Repo Discovery

The suite always benchmarks the ai-cortex repo itself.

It also checks optional local repos when present:

- `~/Dev/ai-samantha`
- `~/Dev/ai-14all`
- `~/Dev/ai-whisper`

Add more repos with:

```bash
BENCH_REPOS=/path/to/repo-a,/path/to/repo-b pnpm bench
```

Run one repo:

```bash
pnpm bench --repo ai-cortex
```

## Ranker Quality Bench

There is also a PR-corpus ranker benchmark under:

```text
benchmarks/ranker-quality/
```

It compares fast, deep, semantic, and combined ranking modes against known truth files.

Run with the built-in example corpus:

```bash
node benchmarks/ranker-quality/run.mjs --repo /path/to/target-repo
```

Run with a custom corpus:

```bash
BENCH_RANKER_REPO=/path/to/target-repo \
  node benchmarks/ranker-quality/run.mjs --corpus /path/to/corpus.json
```

For the corpus schema, see [benchmarks/ranker-quality/README.md](../../benchmarks/ranker-quality/README.md).

## Directory Structure

```text
benchmarks/
  runner.ts
  config.ts
  baselines.example.json
  baselines.json
  results.json
  tsconfig.json
  smoke.test.ts
  lib/
  suites/
  reporters/
  fixtures/
  eval/
  ranker-quality/
```

Important paths:

| Path | Purpose |
|---|---|
| `benchmarks/runner.ts` | Main benchmark CLI |
| `benchmarks/config.ts` | Repo discovery, SLO table, ranking assertions |
| `benchmarks/lib/` | Timing, comparison, shared types |
| `benchmarks/suites/` | Performance and quality suites |
| `benchmarks/fixtures/` | Synthetic fixture repo and golden sets |
| `benchmarks/eval/` | Evaluation harness |
| `benchmarks/ranker-quality/` | PR-corpus ranker quality tooling |

## Calibrating SLOs

If SLO values are too tight or too loose after hardware changes:

```bash
pnpm bench:perf --fast
```

Then edit `benchmarks/config.ts` and update `SLO_TABLE`.

Set each SLO to roughly three to five times the observed p50, then verify:

```bash
pnpm bench:perf
```

## Related Docs

- [CLI reference](./cli.md): command-line surface.
- [Language support](./language-support.md): parser-backed analysis coverage.
- [Library API](./library-api.md): structural API used by benchmarks.
