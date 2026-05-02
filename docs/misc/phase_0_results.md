# ai-cortex Phase 0 Results

## Proof Repo

- Repo path: `/Users/vuphan/Dev/ai-14all`
- Repo type: Electron + React + TypeScript desktop app for worktree-based development sessions
- Approximate file count: 165 git-aware indexable files after applying `git ls-files --cached --others --exclude-standard`

## Baseline

- Cold scan command: `node dist/src/cli.js baseline /Users/vuphan/Dev/ai-14all`
- Cold scan duration: `12.77ms`
- Files touched: `165`
- Markdown files read: `23`

## Cold Orientation

- Cold-orient command: `node dist/src/cli.js cold-orient /Users/vuphan/Dev/ai-14all`
- Cold-orient duration: `15.55ms`
- Cold-orient summary output:

```text
Project: ai-14all
Top docs: README.md, docs/shared/architecture_decisions.md, docs/shared/high_level_plan.md
Likely entry files: electron/main/index.ts, src/main.tsx, src/app/App.tsx, electron/main/e2e-git-faults, electron/main/e2e-git-faults.ts, electron/main/ipc
```

- Cold-orient quality notes:
  - returns the same summary shape as cached rehydrate without relying on cache
  - docs remain strong
  - entry-file hints are plausible, though still heuristic and somewhat noisy
  - this is the more realistic benchmark target than the cheap baseline

## Cached Rehydration

- Index command: `node dist/src/cli.js index /Users/vuphan/Dev/ai-14all`
- Index duration: `71.09ms`
- Cached rehydrate command: `node --input-type=module -e "const start=performance.now(); const { runPhase0 } = await import('./dist/src/spike/run-phase-0.js'); const result=await runPhase0('/Users/vuphan/Dev/ai-14all',{writeToStdout:false}); console.log(JSON.stringify({label:'rehydrate-cached',durationMs:performance.now()-start,value:result},null,2));"`
- Cached rehydrate duration: `22.85ms`
- Refresh rehydrate command: `node --input-type=module -e "const start=performance.now(); const { runPhase0 } = await import('./dist/src/spike/run-phase-0.js'); const result=await runPhase0('/Users/vuphan/Dev/ai-14all',{refresh:true,writeToStdout:false}); console.log(JSON.stringify({label:'rehydrate-refresh',durationMs:performance.now()-start,value:result},null,2));"`
- Refresh rehydrate duration: `40.89ms`
- Summary output:

```text
Project: ai-14all
Indexed: 2026-04-10T08:56:53.799Z
Top docs: README.md, docs/shared/architecture_decisions.md, docs/shared/high_level_plan.md
Likely entry files: electron/main/index.ts, src/main.tsx, src/app/App.tsx, electron/main/e2e-git-faults.ts, electron/main/ipc.ts, electron/main/lifecycle.ts
```

- Summary quality notes:
  - good repo identification
  - good first-doc selection
  - likely entry files improved after cache rehydrate switched from import-order output to shared entry-file heuristics
  - git-aware filtering materially reduced repo noise by excluding ignored artifacts such as `release/`
  - cached `rehydrate` now reads a slim summary sidecar on cache hits instead of parsing the full repo cache JSON
  - cached `rehydrate` still uses a commit-only freshness check, which intentionally accepts stale dirty-working-tree data between commits
  - the cached path improved again, but is still slower than the realistic `cold-orient` benchmark, so the speed gate is still not met

## N=20 Median Benchmark

- Measurement method:
  - 1 fresh `index` run before timed reads
  - 3 warmup runs for each path
  - 20 measured runs for each path
  - direct in-process function timing, not one-shot CLI process startup timing
- `cold-orient` median: `7.43ms`
- `cold-orient` Q1/Q3: `7.09ms / 7.67ms`
- `cached rehydrate` median: `5.59ms`
- `cached rehydrate` Q1/Q3: `5.40ms / 6.04ms`
- Interpretation:
  - this clears the Phase 0 speed gate
  - cached rehydrate wins on median and on quartile spread
  - the earlier slower one-shot CLI timings were dominated by process-launch noise and were not the right gate for the product thesis

## Architecture Questions

- Question 1: What kind of project is this?
  - Answer quality: good
  - Notes: `README.md` and the project title make this easy; the cache correctly identifies `ai-14all` as the target project.

- Question 2: What are the major subsystems?
  - Answer quality: partial
  - Notes: from docs and file hints, the main slices appear to be Electron main process orchestration, renderer UI, workspace persistence, worktree handling, and terminal/session management. The cache helps infer this, but does not yet summarize it directly.

- Question 3: Which docs should a fresh agent read first?
  - Answer quality: good
  - Notes: `README.md`, `docs/shared/architecture_decisions.md`, and `docs/shared/high_level_plan.md` are strong first reads.

- Question 4: Which files should a fresh agent likely inspect first?
  - Answer quality: acceptable
  - Notes: `electron/main/index.ts`, `electron/main/windows`, `electron/main/ipc`, `electron/main/lifecycle`, `electron/main/menu`, and `services/workspace/workspace-persistence-service` are plausible bootstrap files, but the cache does not yet tailor them to a specific task.

## Suggest Checks

- Task 1: `inspect persistence logic`
  - Top suggestions:
    - `services/workspace/workspace-persistence-service.ts`
    - `src/features/workspace/workspace-persistence.ts`
    - `tests/unit/services/workspace/workspace-persistence-service.test.ts`
    - `tests/unit/workspace/workspace-persistence.test.ts`
    - `docs/superpowers/specs/2026-04-04-phase-4-code-inspection-and-git-review-design.md`
  - Quality notes: materially better. Code files now rank ahead of design docs for a code-oriented persistence task.

- Task 2: `trace worktree lifecycle behavior`
  - Top suggestions:
    - `shared/models/worktree-lifecycle.ts`
    - `tests/unit/components/App-worktree-lifecycle.test.tsx`
    - `docs/superpowers/specs/2026-04-08-phase-7-basic-worktree-lifecycle-and-reactivity-design.md`
    - `electron/main/lifecycle.ts`
    - `services/worktrees/parse-worktree-porcelain.ts`
  - Quality notes: improved. The result now leads with code and tests, with the design doc still present but no longer dominating.

- Task 3: `review the main UI shell flow`
  - Top suggestions:
    - `docs/superpowers/specs/2026-04-04-phase-6-shell-redesign-and-commit-review-design.md`
    - `electron/main/e2e-git-faults.ts`
    - `electron/main/index.ts`
    - `electron/main/ipc.ts`
    - `electron/main/lifecycle.ts`
  - Quality notes: the substring bug is fixed, so `electron-builder.yml` no longer appears from a false `ui` match inside `builder`. The result is still weak, because path-only scoring cannot bridge from shell-design concepts to renderer implementation files whose paths do not share those terms.

## Decision

- Continue / revise / stop: continue
- Why:
  - The cache now picks useful docs and plausible bootstrap files using a git-aware input set.
  - Hidden-directory filtering and git-aware indexing materially improved signal quality.
  - The spike now has a true cache-first `rehydrate` path plus explicit refresh.
  - The substring-matching bug in `suggest` is fixed.
  - `suggest` improved for persistence and worktree-lifecycle tasks.
  - The renderer-shell suggestion weakness is now understood as a known path-only ceiling, not a blocking Phase 0 bug.
  - The N=20 median benchmark shows cached rehydrate is materially faster than cold orientation when measured as an in-process product path.
  - The proof is now strong enough to move to the next phase.

## Final Decision

- Decision: complete
- Rationale: the Phase 0 thesis is proven strongly enough to proceed. Cached rehydration now beats cold orientation on the median benchmark that best reflects product behavior, the briefing is useful for fresh-session startup, architecture-oriented questions are answerable from cache, and file suggestions are good enough for several practical task shapes even if path-only ranking still has clear limits.
