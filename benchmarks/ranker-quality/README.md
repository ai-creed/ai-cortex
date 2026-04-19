# Ranker Quality Bench

Runs fast, deep, semantic, and deep+semantic (RRF) against the 20-PR target-repo sample
from the 2026-04-15 benchmark.

## Prerequisites

- target-repo repo clone accessible locally
- `pnpm build` (runner does this automatically)
- First run downloads the embedding model (~23 MB) and builds a vector index

## Usage

```bash
node benchmarks/ranker-quality/run.mjs --repo /path/to/target-repo-clone
# or
BENCH_RANKER_REPO=/path/to/target-repo-clone node benchmarks/ranker-quality/run.mjs
```

## Output

- `benchmarks/ranker-quality/out/aggregate.md` — hit@5, P@5, R@5 per mode
- `benchmarks/ranker-quality/out/per-pr.md` — top-5 per mode per PR with truth markers

## Success gate (for promoting semantic into deep)

- `semantic hit@5 ≥ deep hit@5 + 10pts` (≥ 6/20 if deep stays at 4/20)
- `semantic` or `rrf` keeps all 4 existing deep wins (PRs #2298, #2292, #2282, #2277)
