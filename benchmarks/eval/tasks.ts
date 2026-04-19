// benchmarks/eval/tasks.ts
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { EvalTask } from "./types.js";

function selfRepoRoot(): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		cwd: path.dirname(new URL(import.meta.url).pathname),
	}).trimEnd();
}

export function getEvalTasks(): EvalTask[] {
	const cortexPath = selfRepoRoot();
	const fourallPath = path.join(os.homedir(), "Dev", "ai-14all");

	return [
		{
			name: "cli-help-flag",
			repo: "ai-cortex",
			repoPath: cortexPath,
			prompt: "Add a --help flag to the ai-cortex CLI. When the user runs `ai-cortex --help`, it should print usage information listing all commands (index, rehydrate, suggest, mcp) and exit with code 0.",
			groundTruthFiles: ["src/cli.ts"],
			structuralChecks: [
				{ file: "src/cli.ts", pattern: "--help", shouldMatch: true },
			],
			verifyCommand: "pnpm build && node dist/src/cli.js --help | grep -q index && node dist/src/cli.js --help | grep -q suggest",
			needsBuild: true,
			timeoutMs: 300000,
		},
		{
			name: "index-cached-annotation",
			repo: "ai-cortex",
			repoPath: cortexPath,
			prompt: "Make the `index` CLI command print a `(cached)` annotation in its output when the result came from an existing cache instead of a fresh index. Currently both cases print the same output.",
			groundTruthFiles: ["src/cli.ts"],
			structuralChecks: [
				{ file: "src/cli.ts", pattern: "cached", shouldMatch: true },
			],
			verifyCommand: "pnpm build && node dist/src/cli.js index . && node dist/src/cli.js index . 2>&1 | grep -qi cached",
			needsBuild: true,
			timeoutMs: 300000,
		},
		{
			name: "briefing-doc-limit",
			repo: "ai-cortex",
			repoPath: cortexPath,
			prompt: "The `renderKeyDocs` function in `src/lib/briefing.ts` hardcodes `slice(0, 3)` to show only 3 docs, but `loadDocs` in `doc-inputs.ts` loads up to 8. Fix `renderKeyDocs` so it doesn't truncate to 3.",
			groundTruthFiles: ["src/lib/briefing.ts"],
			structuralChecks: [
				{ file: "src/lib/briefing.ts", pattern: "slice\\(0,\\s*3\\)", shouldMatch: false },
			],
			verifyCommand: "pnpm vitest run tests/unit/lib/briefing-eval.test.ts",
			needsBuild: false,
			timeoutMs: 300000,
		},
		{
			name: "mcp-blast-radius-tests",
			repo: "ai-cortex",
			repoPath: cortexPath,
			prompt: "The MCP server test suite at `tests/unit/mcp/server.test.ts` has tests for `rehydrate_project`, `suggest_files`, and `index_project`, but no tests for the `blast_radius` tool. Add unit tests for `blast_radius` covering: successful invocation, error on `RepoIdentityError`, and error on `IndexError`.",
			groundTruthFiles: ["tests/unit/mcp/server.test.ts"],
			structuralChecks: [
				{ file: "tests/unit/mcp/server.test.ts", pattern: "blast_radius", shouldMatch: true },
			],
			verifyCommand: "pnpm vitest run tests/unit/mcp/server.test.ts",
			needsBuild: false,
			timeoutMs: 300000,
		},
		{
			name: "node-framework-detection",
			repo: "ai-cortex",
			repoPath: cortexPath,
			prompt: 'The `detectFramework` function in `src/lib/entry-files.ts` never returns `"node"` even though `FRAMEWORK_CONVENTIONS` already has a `"node"` entry. Add detection: if `@types/node` or `tsx` is in devDependencies, return `"node"`.',
			groundTruthFiles: ["src/lib/entry-files.ts"],
			structuralChecks: [
				{ file: "src/lib/entry-files.ts", pattern: '"node"', shouldMatch: true },
			],
			verifyCommand: "pnpm vitest run tests/unit/lib/entry-files-eval.test.ts",
			needsBuild: false,
			timeoutMs: 300000,
		},
		{
			name: "sidebar-resizable",
			repo: "ai-14all",
			repoPath: fourallPath,
			prompt: "Make the session sidebar resizable by dragging its right edge. The review rail in the same codebase already has this pattern — look for `handleReviewRailResizeStart` in `App.tsx` and `.shell-review-grid__resize-handle` in `shell.css` and follow the same approach for the sidebar.",
			groundTruthFiles: ["src/app/App.tsx", "src/app/shell.css"],
			structuralChecks: [
				{ file: "src/app/App.tsx", pattern: "sidebarWidth", shouldMatch: true },
				{ file: "src/app/shell.css", pattern: "col-resize", shouldMatch: true },
			],
			verifyCommand: 'grep -q "sidebarWidth" src/app/App.tsx && grep -q "sidebar-resize" src/app/shell.css',
			needsBuild: false,
			timeoutMs: 300000,
		},
	];
}
