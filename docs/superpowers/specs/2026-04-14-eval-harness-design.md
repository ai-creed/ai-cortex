# Evaluation Harness: ai-cortex Briefing Impact

## Purpose

Measure whether ai-cortex rehydrate briefings make AI agents more effective at coding tasks. The harness runs each task twice — with and without a briefing prepended to the prompt — and compares exploration cost, speed, and correctness.

The output is a comparison table suitable for presenting to a team as evidence that briefings improve agent performance.

## Architecture

```
benchmarks/eval/
  runner.ts          # CLI entry: parses args, orchestrates runs
  tasks.ts           # Task definitions (prompt, ground truth, checks)
  harness.ts         # Core loop: worktree setup, agent spawn, metric capture, cleanup
  metrics.ts         # Parse Claude Code output for tool call counts, timing
  verify.ts          # Run structural checks + verification tests
  report.ts          # Terminal table + JSON output
  results/           # gitignored, JSON reports land here
```

### CLI

```bash
pnpm eval                              # Run all tasks, both conditions, 3 reps
pnpm eval --reps 5                     # More reps for tighter confidence
pnpm eval --tasks cli-help-flag        # Single task
pnpm eval --condition with             # Only the "with briefing" condition
pnpm eval --condition without          # Only the "without briefing" condition
```

### Dependencies

- `claude` CLI installed and available on PATH
- `ai-cortex` built (`pnpm build`) for rehydrate briefing generation
- Git (for worktree management)

## Task Definition Format

```ts
type EvalTask = {
	name: string; // e.g. "cli-help-flag"
	repo: string; // "ai-cortex" or "ai-14all"
	repoPath: string; // resolved at runtime
	prompt: string; // the task description given to the agent
	groundTruthFiles: string[]; // files the agent should touch
	structuralChecks: StructuralCheck[]; // grep-based checks run after agent finishes
	verifyCommand: string; // shell command that exits 0 on success
	timeoutMs: number; // kill the agent after this (default 300000 = 5min)
};

type StructuralCheck = {
	file: string; // relative to repo root
	pattern: string; // regex to grep for
	shouldMatch: boolean; // true = must match, false = must NOT match
};
```

## Execution Flow

For each task × condition × rep:

1. **Create git worktree** from HEAD

   ```
   git worktree add --detach .worktrees/eval-<task>-<condition>-<rep>
   ```

2. **Generate briefing** (if condition === "with")

   ```
   ai-cortex rehydrate <worktree-path>
   ```

   Capture the briefing markdown output.

3. **Build the prompt**
   - WITHOUT: `"You are working in <worktree-path>. <task.prompt>"`
   - WITH: `"You are working in <worktree-path>. Here is a project briefing:\n<briefing>\n\n<task.prompt>"`

4. **Spawn the agent**

   ```
   claude --print --dangerously-skip-permissions -p "<prompt>" --cwd <worktree-path>
   ```

   Capture: stdout (full transcript), wall clock time, exit code.

5. **Build the project** (if needed)
   Run `pnpm build` in the worktree for tasks that need compiled output for verification.

6. **Run verification**
   a. Structural checks — grep each pattern in each file
   b. Verify command — run `task.verifyCommand` in the worktree
   c. Files touched — `git diff --name-only` vs ground truth

7. **Collect metrics**
   - `explorationCalls`: count of Read/Grep/Glob/Bash tool uses before first Edit/Write
   - `totalToolCalls`: total tool uses
   - `wallClockMs`: end-to-end wall clock time
   - `filesCorrect`: Jaccard index — `|intersection| / |union|` of touched vs ground truth
   - `structuralPass`: all structural checks passed
   - `verifyPass`: verify command exited 0

8. **Clean up worktree**
   ```
   git worktree remove --force .worktrees/eval-<task>-<condition>-<rep>
   ```

### Key decisions

- `--dangerously-skip-permissions` — required for unattended overnight runs (no approval prompts).
- Briefing is generated fresh per worktree, not cached — both conditions start from identical git state.
- Worktrees are fully isolated — agent changes in one run cannot leak into another.

## Metrics

```ts
type RunResult = {
	task: string;
	condition: "with" | "without";
	rep: number;
	explorationCalls: number;
	totalToolCalls: number;
	wallClockMs: number;
	filesCorrect: number; // jaccard: |intersection| / |union|
	structuralPass: boolean;
	verifyPass: boolean;
	agentExitCode: number;
};
```

### Parsing Claude Code output

`claude --print` writes the full conversation to stdout. Each tool call appears as a text block. Count lines matching tool use patterns (Read, Grep, Glob, Bash, Edit, Write) and note the position of the first Edit/Write to split exploration vs implementation calls.

## Report Output

### Terminal table

```
── Evaluation Results ──────────────────────────────────────────────────

  task                 condition   explore   total   time    files   struct  verify
  cli-help-flag        with        3.0       12.3    45s     1.00    pass    pass
  cli-help-flag        without     14.7      28.0    92s     1.00    pass    pass
  briefing-doc-limit   with        2.3       8.7     38s     1.00    pass    pass
  briefing-doc-limit   without     11.0      19.3    71s     0.50    fail    fail

── Summary ─────────────────────────────────────────────────────────────

                        With briefing    Without briefing    Delta
  Exploration calls     3.2 avg          14.1 avg            -77%
  Total tool calls      11.4 avg         22.8 avg            -50%
  Wall clock time       42s avg          79s avg             -47%
  Files accuracy        0.93 avg         0.68 avg            +37%
  Structural pass       100%             60%
  Verify pass           93%              53%
```

Values are averaged across reps per task per condition. The summary delta row is the key evidence for team presentation.

### JSON report

Written to `benchmarks/eval/results/<timestamp>.json` for historical tracking. Contains all `RunResult` entries plus the summary statistics.

## Task Set

### Task 1: `cli-help-flag` (ai-cortex)

- **Prompt**: "Add a --help flag to the ai-cortex CLI. When the user runs `ai-cortex --help`, it should print usage information listing all commands (index, rehydrate, suggest, mcp) and exit with code 0."
- **Ground truth files**: `src/cli.ts`
- **Structural checks**:
  - `src/cli.ts` contains `--help`
- **Verify command**: `node dist/src/cli.js --help | grep -q index && node dist/src/cli.js --help | grep -q suggest`

### Task 2: `index-cached-annotation` (ai-cortex)

- **Prompt**: "Make the `index` CLI command print a `(cached)` annotation in its output when the result came from an existing cache instead of a fresh index. Currently both cases print the same output."
- **Ground truth files**: `src/cli.ts`
- **Structural checks**:
  - `src/cli.ts` contains `cached`
- **Verify command**: run index twice against the worktree; second invocation's stdout contains "cached"
  ```
  node dist/src/cli.js index . && node dist/src/cli.js index . 2>&1 | grep -qi cached
  ```

### Task 3: `briefing-doc-limit` (ai-cortex)

- **Prompt**: "The `renderKeyDocs` function in `src/lib/briefing.ts` hardcodes `slice(0, 3)` to show only 3 docs, but `loadDocs` in `doc-inputs.ts` loads up to 8. Fix `renderKeyDocs` so it doesn't truncate to 3."
- **Ground truth files**: `src/lib/briefing.ts`
- **Structural checks**:
  - `src/lib/briefing.ts` does NOT contain `slice(0, 3)`
- **Verify command**: pre-written test that passes a 5-doc cache and asserts all 5 appear in the `## Key Docs` section
  ```
  pnpm vitest run tests/unit/lib/briefing-eval.test.ts
  ```
  The test file `tests/unit/lib/briefing-eval.test.ts` is placed in the worktree before the agent runs. It imports `renderBriefing`, builds a cache with 5 docs, and asserts all 5 paths appear in the output.

### Task 4: `mcp-blast-radius-tests` (ai-cortex)

- **Prompt**: "The MCP server test suite at `tests/unit/mcp/server.test.ts` has tests for `rehydrate_project`, `suggest_files`, and `index_project`, but no tests for the `blast_radius` tool. Add unit tests for `blast_radius` covering: successful invocation, error on `RepoIdentityError`, and error on `IndexError`."
- **Ground truth files**: `tests/unit/mcp/server.test.ts`
- **Structural checks**:
  - `tests/unit/mcp/server.test.ts` contains `blast_radius`
- **Verify command**:
  ```
  pnpm vitest run tests/unit/mcp/server.test.ts
  ```

### Task 5: `node-framework-detection` (ai-cortex)

- **Prompt**: "The `detectFramework` function in `src/lib/entry-files.ts` never returns `\"node\"` even though `FRAMEWORK_CONVENTIONS` already has a `\"node\"` entry. Add detection: if `@types/node` or `tsx` is in devDependencies, return `\"node\"`."
- **Ground truth files**: `src/lib/entry-files.ts`
- **Structural checks**:
  - `src/lib/entry-files.ts` contains `"node"` in the `detectFramework` function body
- **Verify command**: pre-written test that mocks `devDependencies: { tsx: "^4.0.0" }` and asserts `framework === "node"`
  ```
  pnpm vitest run tests/unit/lib/entry-files-eval.test.ts
  ```
  The test file is placed in the worktree before the agent runs.

### Task 6: `sidebar-resizable` (ai-14all)

- **Prompt**: "Make the session sidebar resizable by dragging its right edge. The review rail in the same codebase already has this pattern — look for `handleReviewRailResizeStart` in `App.tsx` and `.shell-review-grid__resize-handle` in `shell.css` and follow the same approach for the sidebar."
- **Ground truth files**: `src/app/App.tsx`, `src/app/shell.css`
- **Structural checks**:
  - `src/app/App.tsx` contains `sidebarWidth`
  - `src/app/shell.css` contains `col-resize` (in a new sidebar-specific rule)
- **Verify command**:
  ```
  grep -q "sidebarWidth" src/app/App.tsx && grep -q "sidebar-resize" src/app/shell.css
  ```

## Pre-placed verification tests

Tasks 3 and 5 require verification tests that exercise the agent's changes. These test files are:

- Written as part of the harness implementation (committed alongside the harness code)
- Copied into the worktree before the agent runs
- NOT visible to the "without briefing" agent as hints — they test the expected outcome but don't reveal the implementation approach

The tests are placed at paths the agent wouldn't naturally look at (`tests/unit/lib/<name>-eval.test.ts`), reducing the chance the agent finds and uses them as implementation guidance.

## .gitignore additions

```
benchmarks/eval/results/
```

## Directory layout after implementation

```
benchmarks/eval/
  runner.ts
  tasks.ts
  harness.ts
  metrics.ts
  verify.ts
  report.ts
  fixtures/
    briefing-eval.test.ts       # pre-placed test for task 3
    entry-files-eval.test.ts    # pre-placed test for task 5
  results/                      # gitignored
```
