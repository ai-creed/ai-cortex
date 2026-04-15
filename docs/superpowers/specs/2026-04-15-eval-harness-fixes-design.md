# Eval Harness Fixes — Design Spec

**Date:** 2026-04-15
**Status:** Approved

## Problem

The eval harness runs agents via `claude --print --output-format stream-json --verbose --dangerously-skip-permissions -p <prompt>` but agents consistently complete with 0 mutation tool calls. Root cause: the user's global `~/.claude/CLAUDE.md` fires a `SessionStart` hook that loads the caveman skill and enforces rule #6 ("before writing any code, describe your approach and wait for approval"). In `--print` non-interactive mode there is no user to approve, so the agent explores, plans, then exits without making changes.

Three secondary issues also need fixing:
- `generateBriefing` silently swallows all failures with no diagnostic output.
- `getTouchedFiles` misses untracked new files created by the agent.
- No way to preview what a run will do without actually spawning agents.

---

## Fix 1: Worktree CLAUDE.md Override

**File:** `benchmarks/eval/harness.ts`

Write a minimal `CLAUDE.md` into the worktree root before spawning the agent. Claude Code reads `CLAUDE.md` from cwd upward; the local file takes precedence over `~/.claude/CLAUDE.md`, suppressing the approval gate and SessionStart hook overhead.

**New helper** added to `harness.ts`:

```ts
function writeEvalClaudeMd(worktreePath: string): void {
	const content = [
		"You are running in an automated evaluation harness.",
		"Proceed directly with all implementation.",
		"Do not ask for approval, do not ask clarifying questions, do not invoke any skills.",
		"Make all changes immediately and completely.",
	].join(" ");
	fs.writeFileSync(path.join(worktreePath, "CLAUDE.md"), content + "\n");
}
```

**Call site:** `executeRun`, immediately after `createWorktree` and before `copyFixtures`.

No cleanup needed — the worktree is removed in the `finally` block.

---

## Fix 2: Briefing Failure Logging

**File:** `benchmarks/eval/harness.ts`

`generateBriefing` currently returns `""` silently on any error. Add `process.stderr.write` at each of the three failure points so the operator can see what went wrong without searching logs.

Three cases to log (all to stderr, prefixed with `  [briefing]`):

| Case | Message |
|------|---------|
| `spawnSync` stdout is empty | `[briefing] empty stdout from rehydrate` |
| JSON parse fails or `briefingPath` missing | `[briefing] unexpected rehydrate output` |
| `fs.readFileSync` throws | `[briefing] failed to read briefing file: <err.message>` |

No changes to `RunResult`, report output, or any other file.

---

## Fix 3: `filesCorrect` Includes Untracked New Files

**File:** `benchmarks/eval/verify.ts`

`getTouchedFiles` runs only `git diff --name-only HEAD`, which sees modifications to tracked files but misses files the agent creates from scratch (untracked, never committed).

**Fix:** Run a second command and union the results:

```ts
export function getTouchedFiles(worktreePath: string): string[] {
	const run = (args: string[]) => {
		try {
			return execFileSync("git", args, {
				cwd: worktreePath, encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trimEnd().split("\n").filter((l) => l.length > 0);
		} catch {
			return [];
		}
	};

	const modified = run(["diff", "--name-only", "HEAD"]);
	const untracked = run(["ls-files", "--others", "--exclude-standard"]);
	return [...new Set([...modified, ...untracked])];
}
```

No interface changes — return type stays `string[]`.

---

## Fix 4: `--dry-run` Mode

**File:** `benchmarks/eval/runner.ts`

Add `--dry-run` flag to `parseArgs`. When set, skip all `executeRun` calls and print a preview table showing which tasks would run, their repos, paths, and whether each repo exists on disk.

**Argument parsing addition:**

```ts
let dryRun = false;
// in loop:
if (arg === "--dry-run") { dryRun = true; }
```

**Dry-run output format:**

```
ai-cortex evaluation harness [DRY RUN]

Tasks: <names>
Conditions: <conditions>
Reps: <n>
Total runs: <n>

  <task name padded>  <repo padded>  <path padded>  ✓ / ✗ (not found)

No agents spawned.
```

Exits with code 0 if all repos exist, code 1 if any repo is missing (so it can be used as a pre-flight check).

---

## Files Changed

| File | Change |
|------|--------|
| `benchmarks/eval/harness.ts` | Add `writeEvalClaudeMd`, call in `executeRun`, add briefing failure logs |
| `benchmarks/eval/verify.ts` | Update `getTouchedFiles` to include untracked files |
| `benchmarks/eval/runner.ts` | Add `--dry-run` flag to `parseArgs` and main |

No new files. No schema changes. No dependency additions.

---

## Testing

- **Fix 1:** Run `pnpm eval --tasks cli-help-flag --reps 1` and verify `totalToolCalls > explorationCalls` (agent makes at least one Edit/Write call).
- **Fix 2:** Temporarily break the briefing path and confirm stderr shows the relevant `[briefing]` message.
- **Fix 3:** Unit test in `verify.test.ts`: use `vi.mock("node:child_process")` to stub `execFileSync`, return different file lists for `diff` vs `ls-files` calls, assert the union is returned with no duplicates.
- **Fix 4:** Run `pnpm eval --dry-run` and verify output lists all tasks with repo existence markers; run with a non-existent repo and verify exit code 1.
