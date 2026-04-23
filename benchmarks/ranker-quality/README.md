# Ranker Quality Bench

Runs fast, deep, semantic, and deep+semantic (RRF) against a user-supplied corpus
of real PRs and measures hit@5 / P@5 / R@5 against known truth files.

## Corpus format

`corpus-example.json` shows the expected schema. Each entry:

```json
{
  "pr": 1001,
  "title": "Login button misaligned on mobile viewport",
  "query": "login button mobile viewport alignment",
  "truth": ["src/auth/login-form.tsx", "src/auth/login.module.css"]
}
```

- `title` — verbatim PR title, used as the query when `--query-source=title`.
- `query` (optional) — a distilled dev-style keyword query, used when `--query-source=card`.
- `truth` — list of paths the fix actually touched, as returned by `git show --stat`.

Point `--corpus` at your own JSON to benchmark against your repo.

## Prerequisites

- A local clone of the target repo accessible at `$BENCH_RANKER_REPO` or passed via `--repo`.
- `pnpm build` (runner does this automatically).
- First run downloads the embedding model (~23 MB) and builds a vector index.

## Usage

```bash
# run against your repo with the built-in example corpus
node benchmarks/ranker-quality/run.mjs --repo /path/to/target-repo

# or with your own corpus
BENCH_RANKER_REPO=/path/to/target-repo \
  node benchmarks/ranker-quality/run.mjs --corpus /path/to/corpus.json

# grep baseline for comparison
node benchmarks/ranker-quality/grep-baseline.mjs --repo /path/to/target-repo
```

## Output

- `out/aggregate.md` — hit@5, P@5, R@5 per (source, mode)
- `out/per-pr.md` — top-5 per mode per PR with truth markers
- `out/grep-baseline.md` — filename/content grep numbers for the same corpus
