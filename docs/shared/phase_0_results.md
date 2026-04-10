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

- Continue / revise / stop: revise
- Why:
  - The cache now picks useful docs and plausible bootstrap files using a git-aware input set.
  - Hidden-directory filtering and git-aware indexing materially improved signal quality.
  - The spike now has a true cache-first `rehydrate` path plus explicit refresh.
  - The new `cold-orient` benchmark is a more honest comparison target than the old cheap baseline.
  - Replacing the git-state fingerprint with a commit-only fingerprint narrowed the speed gap and simplified the cache-hit path.
  - Writing and reading a slim summary sidecar further reduced cache-hit work by avoiding full-cache JSON parsing on rehydrate.
  - The speed gate is still not met against the current baseline.
  - The speed gate is also still not met against the new realistic `cold-orient` benchmark.
  - The substring-matching bug in `suggest` is fixed.
  - `suggest` improved for persistence and worktree-lifecycle tasks, but remains weak on renderer-shell intent because path-only matching has a real ceiling.
  - The spike is promising enough to keep going, but not strong enough to justify calling Phase 0 complete without another iteration.

## Final Decision

- Decision: revise
- Rationale: the thesis is directionally promising, and the git-aware cache reduced a large amount of indexing noise. This revision fixed the substring bug in `suggest`, improved cache-hit behavior by reading a slim summary sidecar, and kept cached output quality stronger than before. Even so, cached rehydrate still loses to cold orientation on the measured proof repo. The next revision should focus on the remaining cache-hit overhead or on tightening the benchmark methodology before adding more product surface area.
