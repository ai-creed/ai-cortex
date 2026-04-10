# ai-cortex Phase 0 Results

## Proof Repo

- Repo path: `/Users/vuphan/Dev/ai-14all`
- Repo type: Electron + React + TypeScript desktop app for worktree-based development sessions
- Approximate file count: 165 git-aware indexable files after applying `git ls-files --cached --others --exclude-standard`

## Baseline

- Cold scan command: `node dist/src/cli.js baseline /Users/vuphan/Dev/ai-14all`
- Cold scan duration: `23.48ms`
- Files touched: `165`
- Markdown files read: `23`

## Cached Rehydration

- Index command: `node dist/src/cli.js index /Users/vuphan/Dev/ai-14all`
- Index duration: `60.06ms`
- Cached rehydrate command: `node --input-type=module -e "const start=performance.now(); const { runPhase0 } = await import('./dist/src/spike/run-phase-0.js'); const result=await runPhase0('/Users/vuphan/Dev/ai-14all',{writeToStdout:false}); console.log(JSON.stringify({label:'rehydrate-cached',durationMs:performance.now()-start,value:result},null,2));"`
- Cached rehydrate duration: `31.36ms`
- Refresh rehydrate command: `node --input-type=module -e "const start=performance.now(); const { runPhase0 } = await import('./dist/src/spike/run-phase-0.js'); const result=await runPhase0('/Users/vuphan/Dev/ai-14all',{refresh:true,writeToStdout:false}); console.log(JSON.stringify({label:'rehydrate-refresh',durationMs:performance.now()-start,value:result},null,2));"`
- Refresh rehydrate duration: `67.13ms`
- Summary output:

```text
Project: ai-14all
Indexed: 2026-04-10T08:09:49.758Z
Top docs: README.md, docs/shared/architecture_decisions.md, docs/shared/high_level_plan.md
Likely entry files: electron/main/index.ts, electron/main/windows, electron/main/ipc, electron/main/lifecycle, electron/main/menu, services/workspace/workspace-persistence-service
```

- Summary quality notes:
  - good repo identification
  - good first-doc selection
  - likely entry files remained plausible after moving to git-aware indexing
  - git-aware filtering materially reduced repo noise by excluding ignored artifacts such as `release/`
  - cached `rehydrate` now uses a true cache-first path with a cheaper git-state freshness check
  - the cached path is still slower than the current baseline, so the speed gate is still not met

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
    - `docs/superpowers/specs/2026-04-04-phase-4-code-inspection-and-git-review-design.md`
    - `docs/superpowers/specs/2026-04-04-phase-5-persistence-and-restore-design.md`
    - `services/workspace/workspace-persistence-service.ts`
    - `src/features/workspace/workspace-persistence.ts`
    - `tests/unit/services/workspace/workspace-persistence-service.test.ts`
  - Quality notes: improved slightly. It now surfaces more code files, but docs still rank too high.

- Task 2: `trace worktree lifecycle behavior`
  - Top suggestions:
    - `docs/superpowers/specs/2026-04-08-phase-7-basic-worktree-lifecycle-and-reactivity-design.md`
    - `shared/models/worktree-lifecycle.ts`
    - `tests/unit/components/App-worktree-lifecycle.test.tsx`
    - `electron/main/lifecycle.ts`
    - `services/worktrees/parse-worktree-porcelain.ts`
  - Quality notes: decent. It surfaces both model and implementation-adjacent files, but still overweights docs.

- Task 3: `review the main UI shell flow`
  - Top suggestions:
    - `docs/superpowers/specs/2026-04-04-phase-6-shell-redesign-and-commit-review-design.md`
    - `docs/superpowers/specs/2026-04-03-phase-2-session-first-workflow-design.md`
    - `docs/superpowers/specs/2026-04-03-radix-terminal-first-shell-design.md`
    - `docs/superpowers/specs/2026-04-04-phase-4-code-inspection-and-git-review-design.md`
    - `docs/superpowers/specs/2026-04-06-markdown-preview-design.md`
  - Quality notes: still weak. This remains mostly document retrieval and does not surface the main renderer shell components.

## Decision

- Continue / revise / stop: revise
- Why:
  - The cache now picks useful docs and plausible bootstrap files using a git-aware input set.
  - Hidden-directory filtering and git-aware indexing materially improved signal quality.
  - The spike now has a true cache-first `rehydrate` path plus explicit refresh.
  - Replacing the all-file fingerprint with a git-state token did not clear the speed gate.
  - The speed gate is still not met against the current baseline.
  - `suggest` remains too doc-heavy and weak on task-specific code targeting.
  - The spike is promising enough to keep going, but not strong enough to justify calling Phase 0 complete without another iteration.

## Final Decision

- Decision: revise
- Rationale: the thesis is directionally promising, and the git-aware cache reduced a large amount of indexing noise, but the current implementation still does not clear the hard gates on measured speed or suggestion quality. The next revision should reduce freshness-check cost further and rebalance suggestion ranking toward implementation files when the task is code-oriented.
