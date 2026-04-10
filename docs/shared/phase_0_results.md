# ai-cortex Phase 0 Results

## Proof Repo

- Repo path: `/Users/vuphan/Dev/ai-14all`
- Repo type: Electron + React + TypeScript desktop app for worktree-based development sessions
- Approximate file count: 488 files touched by the current baseline scanner after hidden-directory filtering

## Baseline

- Cold scan command: `node dist/src/cli.js baseline /Users/vuphan/Dev/ai-14all`
- Cold scan duration: `10.53ms`
- Files touched: `488`
- Markdown files read: `43`

## Cached Rehydration

- Rehydrate command: `node --input-type=module -e "import { measure } from './dist/src/spike/measure.js'; import { buildCache } from './dist/src/spike/build-cache.js'; import { rehydrateFromCache } from './dist/src/spike/rehydrate.js'; const repoPath=process.argv[1]; const result=await measure('rehydrate', () => rehydrateFromCache(buildCache(repoPath))); console.log(JSON.stringify(result, null, 2));" /Users/vuphan/Dev/ai-14all`
- Rehydrate duration: `22.18ms`
- Summary output:

```text
Project: ai-14all
Indexed: 2026-04-10T07:16:14.755Z
Top docs: README.md, docs/shared/architecture_decisions.md, docs/shared/high_level_plan.md
Likely entry files: electron/main/index.ts, electron/main/windows, electron/main/ipc, electron/main/lifecycle, electron/main/menu, services/workspace/workspace-persistence-service
```

- Summary quality notes:
  - good repo identification
  - good first-doc selection
  - likely entry files became much more plausible after excluding hidden directories
  - still too shallow to explain major subsystems directly
  - current output is slower than the current baseline, so the speed gate is not met yet

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
    - `docs/superpowers/plans/2026-04-04-phase-4-code-inspection-and-git-review.md`
    - `docs/superpowers/plans/2026-04-04-phase-5-persistence-and-restore.md`
    - `docs/superpowers/specs/2026-04-04-phase-4-code-inspection-and-git-review-design.md`
    - `docs/superpowers/specs/2026-04-04-phase-5-persistence-and-restore-design.md`
    - `services/workspace/workspace-persistence-service.ts`
  - Quality notes: mixed. It does find the persistence service, but ranks docs too aggressively.

- Task 2: `trace worktree lifecycle behavior`
  - Top suggestions:
    - `docs/superpowers/plans/2026-04-08-phase-7-basic-worktree-lifecycle-and-reactivity.md`
    - `docs/superpowers/specs/2026-04-08-phase-7-basic-worktree-lifecycle-and-reactivity-design.md`
    - `shared/models/worktree-lifecycle.ts`
    - `tests/unit/components/App-worktree-lifecycle.test.tsx`
    - `electron/main/lifecycle.ts`
  - Quality notes: decent. It surfaces both the model and an implementation-adjacent file, but still overweights docs.

- Task 3: `review the main UI shell flow`
  - Top suggestions:
    - `docs/superpowers/plans/2026-04-04-phase-6-shell-redesign-and-commit-review.md`
    - `docs/superpowers/specs/2026-04-04-phase-6-shell-redesign-and-commit-review-design.md`
    - `docs/superpowers/plans/2026-04-03-phase-2-session-first-workflow.md`
    - `docs/superpowers/plans/2026-04-03-radix-terminal-first-shell.md`
    - `docs/superpowers/plans/2026-04-04-phase-4-code-inspection-and-git-review.md`
  - Quality notes: weak. This is mostly document retrieval and does not surface the main renderer entry files or shell components.

## Decision

- Continue / revise / stop: revise
- Why:
  - The cache already picks useful docs and can produce plausible bootstrap files.
  - The hidden-directory bug fix materially improved result quality.
  - The speed gate is not met against the current baseline.
  - `suggest` is still too doc-heavy and weak on task-specific code targeting.
  - The spike is promising enough to keep going, but not strong enough to justify calling Phase 0 complete without another iteration.

## Final Decision

- Decision: revise
- Rationale: the thesis is directionally promising, but the current implementation does not yet clear the hard gates on measured speed or suggestion quality. The next revision should improve the baseline comparison, filter noisy generated/project-artifact areas like `release/`, and rebalance suggestion ranking toward implementation files when the task is code-oriented.
