# Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated A/B evaluation harness that measures whether ai-cortex briefings improve AI agent performance on coding tasks.

**Architecture:** TypeScript scripts under `benchmarks/eval/` that loop over task definitions, spawn Claude Code CLI sessions in isolated git worktrees with/without briefings, parse structured output for tool call metrics, run verification checks, and produce a comparison report.

**Tech Stack:** TypeScript (ESM), Claude Code CLI (`claude --print --output-format stream-json --verbose`), git worktrees for isolation, vitest for pre-placed fixture tests.

---

### Task 1: Types and Task Definitions

**Files:**
- Create: `benchmarks/eval/types.ts`
- Create: `benchmarks/eval/tasks.ts`

- [ ] **Step 1: Create shared types**

```ts
// benchmarks/eval/types.ts

export type StructuralCheck = {
	file: string;
	pattern: string;
	shouldMatch: boolean;
};

export type EvalTask = {
	name: string;
	repo: string;
	repoPath: string;
	prompt: string;
	groundTruthFiles: string[];
	structuralChecks: StructuralCheck[];
	verifyCommand: string;
	needsBuild: boolean;
	timeoutMs: number;
};

export type RunResult = {
	task: string;
	condition: "with" | "without";
	rep: number;
	explorationCalls: number;
	totalToolCalls: number;
	wallClockMs: number;
	filesCorrect: number;
	structuralPass: boolean;
	verifyPass: boolean;
	agentExitCode: number;
};

export type EvalReport = {
	timestamp: string;
	results: RunResult[];
};
```

- [ ] **Step 2: Create task definitions**

```ts
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
			prompt: 'The `renderKeyDocs` function in `src/lib/briefing.ts` hardcodes `slice(0, 3)` to show only 3 docs, but `loadDocs` in `doc-inputs.ts` loads up to 8. Fix `renderKeyDocs` so it doesn\'t truncate to 3.',
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p benchmarks/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/eval/types.ts benchmarks/eval/tasks.ts
git commit -m "feat(eval): add types and task definitions for A/B evaluation harness"
```

---

### Task 2: Pre-placed Verification Test Fixtures

**Files:**
- Create: `benchmarks/eval/fixtures/briefing-eval.test.ts`
- Create: `benchmarks/eval/fixtures/entry-files-eval.test.ts`

These test files are copied into each worktree before the agent runs. They verify the agent's changes are correct.

- [ ] **Step 1: Create the briefing doc limit test fixture**

```ts
// benchmarks/eval/fixtures/briefing-eval.test.ts
//
// Pre-placed verification test for eval task "briefing-doc-limit".
// Copied into the worktree by the eval harness. Tests that renderKeyDocs
// shows all docs, not just 3.
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { renderBriefing } from "../../../src/lib/briefing.js";

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-04-10T09:30:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test-app", version: "1.0.0", framework: null },
		entryFiles: ["src/index.ts"],
		files: [
			{ path: "src/index.ts", kind: "file" },
			{ path: "docs/a.md", kind: "file" },
			{ path: "docs/b.md", kind: "file" },
			{ path: "docs/c.md", kind: "file" },
			{ path: "docs/d.md", kind: "file" },
			{ path: "docs/e.md", kind: "file" },
		],
		docs: [
			{ path: "docs/a.md", title: "Doc A", body: "# A\n" },
			{ path: "docs/b.md", title: "Doc B", body: "# B\n" },
			{ path: "docs/c.md", title: "Doc C", body: "# C\n" },
			{ path: "docs/d.md", title: "Doc D", body: "# D\n" },
			{ path: "docs/e.md", title: "Doc E", body: "# E\n" },
		],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

describe("briefing-doc-limit eval", () => {
	it("renderKeyDocs shows all 5 docs, not just 3", () => {
		const cache = makeCache();
		const md = renderBriefing(cache);
		for (const doc of cache.docs) {
			expect(md).toContain(doc.path);
		}
	});
});
```

- [ ] **Step 2: Create the node framework detection test fixture**

```ts
// benchmarks/eval/fixtures/entry-files-eval.test.ts
//
// Pre-placed verification test for eval task "node-framework-detection".
// Copied into the worktree by the eval harness.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import { readPackageMeta } from "../../../src/lib/entry-files.js";

const mockFs = vi.mocked(fs);

describe("node-framework-detection eval", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("detects node framework when tsx is in devDependencies", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "my-cli",
				version: "1.0.0",
				devDependencies: { tsx: "^4.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("node");
	});

	it("detects node framework when @types/node is in devDependencies", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "my-cli",
				version: "1.0.0",
				devDependencies: { "@types/node": "^22.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("node");
	});

	it("still detects electron over node", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "app",
				version: "1.0.0",
				devDependencies: { electron: "^30.0.0", tsx: "^4.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("electron");
	});
});
```

- [ ] **Step 3: Commit**

```bash
git add benchmarks/eval/fixtures/briefing-eval.test.ts benchmarks/eval/fixtures/entry-files-eval.test.ts
git commit -m "feat(eval): add pre-placed verification test fixtures"
```

---

### Task 3: Metrics Parser

**Files:**
- Create: `benchmarks/eval/metrics.ts`
- Create: `benchmarks/eval/metrics.test.ts`

- [ ] **Step 1: Write failing tests for the metrics parser**

```ts
// benchmarks/eval/metrics.test.ts
import { describe, it, expect } from "vitest";
import { parseStreamJson } from "./metrics.js";

const TOOL_READ = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Read", id: "1", input: {} }] },
});
const TOOL_GREP = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Grep", id: "2", input: {} }] },
});
const TOOL_EDIT = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Edit", id: "3", input: {} }] },
});
const TOOL_WRITE = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Write", id: "4", input: {} }] },
});
const TOOL_BASH = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Bash", id: "5", input: {} }] },
});
const TEXT_BLOCK = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "text", text: "hello" }] },
});
const RESULT_LINE = JSON.stringify({
	type: "result",
	num_turns: 5,
	duration_ms: 12345,
});

describe("parseStreamJson", () => {
	it("counts exploration calls before first edit", () => {
		const output = [TOOL_READ, TOOL_GREP, TOOL_BASH, TOOL_EDIT, TOOL_READ].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(3);
		expect(metrics.totalToolCalls).toBe(5);
	});

	it("counts all calls as exploration when no edits", () => {
		const output = [TOOL_READ, TOOL_GREP, TOOL_READ, RESULT_LINE].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(3);
		expect(metrics.totalToolCalls).toBe(3);
	});

	it("handles Write as first mutation tool", () => {
		const output = [TOOL_READ, TOOL_WRITE, TOOL_READ].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(1);
		expect(metrics.totalToolCalls).toBe(3);
	});

	it("ignores text blocks and unknown types", () => {
		const output = [TEXT_BLOCK, TOOL_READ, TEXT_BLOCK, TOOL_EDIT].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(1);
		expect(metrics.totalToolCalls).toBe(2);
	});

	it("extracts duration from result line", () => {
		const output = [TOOL_READ, RESULT_LINE].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.durationMs).toBe(12345);
	});

	it("returns 0 for empty output", () => {
		const metrics = parseStreamJson("");
		expect(metrics.explorationCalls).toBe(0);
		expect(metrics.totalToolCalls).toBe(0);
		expect(metrics.durationMs).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmarks/eval/metrics.test.ts`
Expected: FAIL — `parseStreamJson` is not defined.

- [ ] **Step 3: Implement the metrics parser**

```ts
// benchmarks/eval/metrics.ts

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Agent", "Skill"]);
const MUTATION_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export type ParsedMetrics = {
	explorationCalls: number;
	totalToolCalls: number;
	durationMs: number;
};

export function parseStreamJson(output: string): ParsedMetrics {
	const lines = output.split("\n").filter((l) => l.trim().length > 0);

	let totalToolCalls = 0;
	let firstMutationIdx = -1;
	let durationMs = 0;
	const toolIndices: number[] = [];

	for (const line of lines) {
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (obj.type === "result") {
			durationMs = (obj.duration_ms as number) ?? 0;
			continue;
		}

		if (obj.type !== "assistant") continue;

		const message = obj.message as { content?: unknown[] } | undefined;
		if (!message?.content) continue;

		for (const block of message.content) {
			const b = block as Record<string, unknown>;
			if (b.type !== "tool_use") continue;

			const name = b.name as string;
			if (!EXPLORATION_TOOLS.has(name) && !MUTATION_TOOLS.has(name)) continue;

			toolIndices.push(totalToolCalls);
			totalToolCalls++;

			if (firstMutationIdx < 0 && MUTATION_TOOLS.has(name)) {
				firstMutationIdx = totalToolCalls - 1;
			}
		}
	}

	const explorationCalls = firstMutationIdx < 0 ? totalToolCalls : firstMutationIdx;

	return { explorationCalls, totalToolCalls, durationMs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmarks/eval/metrics.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/eval/metrics.ts benchmarks/eval/metrics.test.ts
git commit -m "feat(eval): add metrics parser for Claude Code stream-json output"
```

---

### Task 4: Verification Runner

**Files:**
- Create: `benchmarks/eval/verify.ts`
- Create: `benchmarks/eval/verify.test.ts`

- [ ] **Step 1: Write failing tests for verification**

```ts
// benchmarks/eval/verify.test.ts
import { describe, it, expect } from "vitest";
import { checkStructural, computeFilesCorrect } from "./verify.js";

describe("checkStructural", () => {
	it("returns true when pattern matches and shouldMatch is true", () => {
		expect(checkStructural("hello world\nfoo bar", "foo", true)).toBe(true);
	});

	it("returns false when pattern does not match and shouldMatch is true", () => {
		expect(checkStructural("hello world", "foo", true)).toBe(false);
	});

	it("returns true when pattern does not match and shouldMatch is false", () => {
		expect(checkStructural("hello world", "foo", false)).toBe(true);
	});

	it("returns false when pattern matches and shouldMatch is false", () => {
		expect(checkStructural("hello world\nfoo bar", "foo", false)).toBe(false);
	});

	it("supports regex patterns", () => {
		expect(checkStructural("slice(0, 3)", "slice\\(0,\\s*3\\)", true)).toBe(true);
	});
});

describe("computeFilesCorrect", () => {
	it("returns 1.0 for exact match", () => {
		expect(computeFilesCorrect(["a.ts", "b.ts"], ["a.ts", "b.ts"])).toBe(1);
	});

	it("returns 0.5 for partial overlap", () => {
		expect(computeFilesCorrect(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBeCloseTo(1 / 3);
	});

	it("returns 0 for no overlap", () => {
		expect(computeFilesCorrect(["a.ts"], ["b.ts"])).toBe(0);
	});

	it("returns 0 when both are empty", () => {
		expect(computeFilesCorrect([], [])).toBe(0);
	});

	it("handles touched superset of ground truth", () => {
		expect(computeFilesCorrect(["a.ts"], ["a.ts", "b.ts"])).toBeCloseTo(0.5);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmarks/eval/verify.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement verification functions**

```ts
// benchmarks/eval/verify.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvalTask } from "./types.js";

export function checkStructural(
	fileContent: string,
	pattern: string,
	shouldMatch: boolean,
): boolean {
	const regex = new RegExp(pattern);
	const matches = regex.test(fileContent);
	return shouldMatch ? matches : !matches;
}

export function computeFilesCorrect(
	groundTruth: string[],
	touched: string[],
): number {
	const gt = new Set(groundTruth);
	const tc = new Set(touched);
	const union = new Set([...gt, ...tc]);
	if (union.size === 0) return 0;
	const intersection = [...gt].filter((f) => tc.has(f));
	return intersection.length / union.size;
}

export function getTouchedFiles(worktreePath: string): string[] {
	try {
		const output = execFileSync(
			"git",
			["diff", "--name-only", "HEAD"],
			{ cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return output.trimEnd().split("\n").filter((l) => l.length > 0);
	} catch {
		return [];
	}
}

export function runVerification(
	task: EvalTask,
	worktreePath: string,
): { structuralPass: boolean; verifyPass: boolean; filesCorrect: number } {
	// Structural checks
	let structuralPass = true;
	for (const check of task.structuralChecks) {
		const filePath = path.join(worktreePath, check.file);
		if (!fs.existsSync(filePath)) {
			structuralPass = false;
			continue;
		}
		const content = fs.readFileSync(filePath, "utf8");
		if (!checkStructural(content, check.pattern, check.shouldMatch)) {
			structuralPass = false;
		}
	}

	// Build if needed
	if (task.needsBuild) {
		try {
			execFileSync("pnpm", ["build"], {
				cwd: worktreePath,
				stdio: "ignore",
				timeout: 30000,
			});
		} catch {
			// Build failure — verify will likely fail too
		}
	}

	// Verify command
	let verifyPass = false;
	try {
		execFileSync("bash", ["-c", task.verifyCommand], {
			cwd: worktreePath,
			stdio: "ignore",
			timeout: 30000,
		});
		verifyPass = true;
	} catch {
		verifyPass = false;
	}

	// Files correctness
	const touched = getTouchedFiles(worktreePath);
	const filesCorrect = computeFilesCorrect(task.groundTruthFiles, touched);

	return { structuralPass, verifyPass, filesCorrect };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmarks/eval/verify.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/eval/verify.ts benchmarks/eval/verify.test.ts
git commit -m "feat(eval): add verification runner with structural checks and Jaccard scoring"
```

---

### Task 5: Harness Core

**Files:**
- Create: `benchmarks/eval/harness.ts`

This is the core execution loop — worktree creation, briefing generation, agent spawning, metric collection, cleanup.

- [ ] **Step 1: Create the harness**

```ts
// benchmarks/eval/harness.ts
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvalTask, RunResult } from "./types.js";
import { parseStreamJson } from "./metrics.js";
import { runVerification } from "./verify.js";

const EVAL_WORKTREE_DIR = ".worktrees";

function createWorktree(repoPath: string, name: string): string {
	const worktreePath = path.join(repoPath, EVAL_WORKTREE_DIR, name);
	execFileSync(
		"git",
		["worktree", "add", "--detach", worktreePath],
		{ cwd: repoPath, stdio: "ignore" },
	);
	return worktreePath;
}

function removeWorktree(repoPath: string, worktreePath: string): void {
	try {
		execFileSync(
			"git",
			["worktree", "remove", "--force", worktreePath],
			{ cwd: repoPath, stdio: "ignore" },
		);
	} catch {
		// Best effort cleanup
	}
}

function generateBriefing(worktreePath: string): string {
	try {
		const result = spawnSync(
			"node",
			[path.join(worktreePath, "dist", "src", "cli.js"), "rehydrate", worktreePath],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
		);
		return result.stdout || "";
	} catch {
		return "";
	}
}

function copyFixtures(task: EvalTask, worktreePath: string): void {
	const fixtureDir = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"fixtures",
	);

	const fixtureMap: Record<string, string> = {
		"briefing-doc-limit": "briefing-eval.test.ts",
		"node-framework-detection": "entry-files-eval.test.ts",
	};

	const fixtureFile = fixtureMap[task.name];
	if (!fixtureFile) return;

	const src = path.join(fixtureDir, fixtureFile);
	if (!fs.existsSync(src)) return;

	const destDir = path.join(worktreePath, "tests", "unit", "lib");
	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(src, path.join(destDir, fixtureFile));
}

function buildPrompt(
	task: EvalTask,
	condition: "with" | "without",
	worktreePath: string,
	briefing: string,
): string {
	const base = `You are working in ${worktreePath}. ${task.prompt}`;
	if (condition === "without") return base;
	return `You are working in ${worktreePath}. Here is a project briefing:\n\n${briefing}\n\n${task.prompt}`;
}

function spawnAgent(
	prompt: string,
	worktreePath: string,
	timeoutMs: number,
): { stdout: string; exitCode: number; wallClockMs: number } {
	const start = performance.now();
	const result = spawnSync(
		"claude",
		[
			"--print",
			"--output-format", "stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"-p", prompt,
		],
		{
			cwd: worktreePath,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		},
	);
	const wallClockMs = Math.round(performance.now() - start);
	return {
		stdout: result.stdout || "",
		exitCode: result.status ?? 1,
		wallClockMs,
	};
}

export type RunOptions = {
	task: EvalTask;
	condition: "with" | "without";
	rep: number;
};

export function executeRun(options: RunOptions): RunResult {
	const { task, condition, rep } = options;
	const worktreeName = `eval-${task.name}-${condition}-${rep}`;

	process.stderr.write(`  ${task.name} / ${condition} / rep ${rep}...\n`);

	// 1. Create worktree
	const worktreePath = createWorktree(task.repoPath, worktreeName);

	try {
		// 2. Copy pre-placed fixtures
		copyFixtures(task, worktreePath);

		// 3. Generate briefing (if needed)
		let briefing = "";
		if (condition === "with") {
			// Build first so ai-cortex CLI is available
			try {
				execFileSync("pnpm", ["build"], {
					cwd: worktreePath,
					stdio: "ignore",
					timeout: 30000,
				});
			} catch {
				// Build might fail; briefing will be empty
			}
			briefing = generateBriefing(worktreePath);
		}

		// 4. Build prompt and spawn agent
		const prompt = buildPrompt(task, condition, worktreePath, briefing);
		const agentResult = spawnAgent(prompt, worktreePath, task.timeoutMs);

		// 5. Parse metrics
		const metrics = parseStreamJson(agentResult.stdout);

		// 6. Run verification
		const verification = runVerification(task, worktreePath);

		return {
			task: task.name,
			condition,
			rep,
			explorationCalls: metrics.explorationCalls,
			totalToolCalls: metrics.totalToolCalls,
			wallClockMs: agentResult.wallClockMs,
			filesCorrect: Math.round(verification.filesCorrect * 100) / 100,
			structuralPass: verification.structuralPass,
			verifyPass: verification.verifyPass,
			agentExitCode: agentResult.exitCode,
		};
	} finally {
		// 7. Cleanup
		removeWorktree(task.repoPath, worktreePath);
	}
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p benchmarks/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/eval/harness.ts
git commit -m "feat(eval): add harness core with worktree isolation and agent spawning"
```

---

### Task 6: Report Generator

**Files:**
- Create: `benchmarks/eval/report.ts`

- [ ] **Step 1: Create the report generator**

```ts
// benchmarks/eval/report.ts
import fs from "node:fs";
import type { RunResult, EvalReport } from "./types.js";

function pad(str: string, len: number): string {
	return str.padEnd(len);
}

function fmtTime(ms: number): string {
	return `${Math.round(ms / 1000)}s`;
}

type TaskSummary = {
	task: string;
	condition: "with" | "without";
	avgExplore: number;
	avgTotal: number;
	avgTime: number;
	avgFiles: number;
	structRate: number;
	verifyRate: number;
};

function summarizeByTaskCondition(results: RunResult[]): TaskSummary[] {
	const groups = new Map<string, RunResult[]>();
	for (const r of results) {
		const key = `${r.task}::${r.condition}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(r);
	}

	const summaries: TaskSummary[] = [];
	for (const [, runs] of groups) {
		const n = runs.length;
		summaries.push({
			task: runs[0].task,
			condition: runs[0].condition,
			avgExplore: runs.reduce((s, r) => s + r.explorationCalls, 0) / n,
			avgTotal: runs.reduce((s, r) => s + r.totalToolCalls, 0) / n,
			avgTime: runs.reduce((s, r) => s + r.wallClockMs, 0) / n,
			avgFiles: runs.reduce((s, r) => s + r.filesCorrect, 0) / n,
			structRate: runs.filter((r) => r.structuralPass).length / n,
			verifyRate: runs.filter((r) => r.verifyPass).length / n,
		});
	}

	return summaries.sort((a, b) =>
		a.task === b.task
			? a.condition.localeCompare(b.condition)
			: a.task.localeCompare(b.task),
	);
}

export function printEvalReport(results: RunResult[]): void {
	const summaries = summarizeByTaskCondition(results);

	console.log("\n── Evaluation Results ──────────────────────────────────────────────────\n");
	console.log(
		`  ${pad("task", 28)}${pad("condition", 12)}${pad("explore", 10)}${pad("total", 10)}${pad("time", 10)}${pad("files", 10)}${pad("struct", 10)}verify`,
	);

	for (const s of summaries) {
		console.log(
			`  ${pad(s.task, 28)}${pad(s.condition, 12)}${pad(s.avgExplore.toFixed(1), 10)}${pad(s.avgTotal.toFixed(1), 10)}${pad(fmtTime(s.avgTime), 10)}${pad(s.avgFiles.toFixed(2), 10)}${pad(s.structRate === 1 ? "pass" : `${Math.round(s.structRate * 100)}%`, 10)}${s.verifyRate === 1 ? "pass" : `${Math.round(s.verifyRate * 100)}%`}`,
		);
	}

	// Overall summary by condition
	const withRuns = results.filter((r) => r.condition === "with");
	const withoutRuns = results.filter((r) => r.condition === "without");

	if (withRuns.length > 0 && withoutRuns.length > 0) {
		const avg = (runs: RunResult[], key: keyof RunResult) =>
			runs.reduce((s, r) => s + (r[key] as number), 0) / runs.length;
		const rate = (runs: RunResult[], key: keyof RunResult) =>
			runs.filter((r) => r[key] === true).length / runs.length;

		const wExplore = avg(withRuns, "explorationCalls");
		const woExplore = avg(withoutRuns, "explorationCalls");
		const wTotal = avg(withRuns, "totalToolCalls");
		const woTotal = avg(withoutRuns, "totalToolCalls");
		const wTime = avg(withRuns, "wallClockMs");
		const woTime = avg(withoutRuns, "wallClockMs");
		const wFiles = avg(withRuns, "filesCorrect");
		const woFiles = avg(withoutRuns, "filesCorrect");
		const wStruct = rate(withRuns, "structuralPass");
		const woStruct = rate(withoutRuns, "structuralPass");
		const wVerify = rate(withRuns, "verifyPass");
		const woVerify = rate(withoutRuns, "verifyPass");

		const delta = (a: number, b: number) => {
			if (b === 0) return "n/a";
			const pct = Math.round(((a - b) / b) * 100);
			return `${pct > 0 ? "+" : ""}${pct}%`;
		};

		console.log("\n── Summary ─────────────────────────────────────────────────────────────\n");
		console.log(`  ${pad("", 24)}${pad("With briefing", 20)}${pad("Without briefing", 20)}Delta`);
		console.log(`  ${pad("Exploration calls", 24)}${pad(wExplore.toFixed(1) + " avg", 20)}${pad(woExplore.toFixed(1) + " avg", 20)}${delta(wExplore, woExplore)}`);
		console.log(`  ${pad("Total tool calls", 24)}${pad(wTotal.toFixed(1) + " avg", 20)}${pad(woTotal.toFixed(1) + " avg", 20)}${delta(wTotal, woTotal)}`);
		console.log(`  ${pad("Wall clock time", 24)}${pad(fmtTime(wTime) + " avg", 20)}${pad(fmtTime(woTime) + " avg", 20)}${delta(wTime, woTime)}`);
		console.log(`  ${pad("Files accuracy", 24)}${pad(wFiles.toFixed(2) + " avg", 20)}${pad(woFiles.toFixed(2) + " avg", 20)}${delta(wFiles, woFiles)}`);
		console.log(`  ${pad("Structural pass", 24)}${pad(Math.round(wStruct * 100) + "%", 20)}${pad(Math.round(woStruct * 100) + "%", 20)}`);
		console.log(`  ${pad("Verify pass", 24)}${pad(Math.round(wVerify * 100) + "%", 20)}${pad(Math.round(woVerify * 100) + "%", 20)}`);
	}

	console.log();
}

export function writeEvalReport(results: RunResult[], outputDir: string): string {
	fs.mkdirSync(outputDir, { recursive: true });
	const report: EvalReport = {
		timestamp: new Date().toISOString(),
		results,
	};
	const fileName = `eval-${report.timestamp.replace(/[:.]/g, "-")}.json`;
	const filePath = `${outputDir}/${fileName}`;
	fs.writeFileSync(filePath, JSON.stringify(report, null, "\t") + "\n");
	process.stderr.write(`Report written to ${filePath}\n`);
	return filePath;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p benchmarks/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/eval/report.ts
git commit -m "feat(eval): add evaluation report generator with comparison table"
```

---

### Task 7: CLI Runner

**Files:**
- Create: `benchmarks/eval/runner.ts`
- Modify: `package.json` — add `eval` script
- Modify: `.gitignore` — add `benchmarks/eval/results/`

- [ ] **Step 1: Create the runner**

```ts
// benchmarks/eval/runner.ts
import path from "node:path";
import fs from "node:fs";
import { getEvalTasks } from "./tasks.js";
import { executeRun } from "./harness.js";
import { printEvalReport, writeEvalReport } from "./report.js";
import type { RunResult } from "./types.js";

function parseArgs(argv: string[]): {
	reps: number;
	taskFilter: string | null;
	condition: "both" | "with" | "without";
} {
	let reps = 3;
	let taskFilter: string | null = null;
	let condition: "both" | "with" | "without" = "both";

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--reps" && argv[i + 1]) {
			reps = parseInt(argv[++i], 10);
		} else if (arg === "--tasks" && argv[i + 1]) {
			taskFilter = argv[++i];
		} else if (arg === "--condition" && argv[i + 1]) {
			condition = argv[++i] as "with" | "without";
		}
	}

	return { reps, taskFilter, condition };
}

const RESULTS_DIR = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"results",
);

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	console.log("ai-cortex evaluation harness\n");

	let tasks = getEvalTasks();

	if (args.taskFilter) {
		tasks = tasks.filter((t) => t.name === args.taskFilter);
		if (tasks.length === 0) {
			console.error(`No task found matching: ${args.taskFilter}`);
			process.exit(1);
		}
	}

	// Filter tasks whose repo path doesn't exist
	tasks = tasks.filter((t) => {
		if (fs.existsSync(t.repoPath)) return true;
		console.error(`Skipping ${t.name}: repo not found at ${t.repoPath}`);
		return false;
	});

	const conditions: Array<"with" | "without"> =
		args.condition === "both" ? ["with", "without"] : [args.condition];

	const totalRuns = tasks.length * conditions.length * args.reps;
	console.log(`Tasks: ${tasks.map((t) => t.name).join(", ")}`);
	console.log(`Conditions: ${conditions.join(", ")}`);
	console.log(`Reps: ${args.reps}`);
	console.log(`Total runs: ${totalRuns}\n`);

	const results: RunResult[] = [];

	for (const task of tasks) {
		for (const condition of conditions) {
			for (let rep = 1; rep <= args.reps; rep++) {
				const result = executeRun({ task, condition, rep });
				results.push(result);
			}
		}
	}

	printEvalReport(results);
	writeEvalReport(results, RESULTS_DIR);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Add eval script to package.json**

Add to `scripts` in `package.json`:
```json
"eval": "tsx benchmarks/eval/runner.ts"
```

- [ ] **Step 3: Add results dir to .gitignore**

Append to `.gitignore`:
```
benchmarks/eval/results/
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p benchmarks/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/eval/runner.ts package.json .gitignore
git commit -m "feat(eval): add CLI runner with --reps, --tasks, --condition flags"
```

---

### Task 8: Dry-run Smoke Test

**Files:** none (validation only)

Run a single task, single condition, single rep to verify end-to-end wiring before committing to a full overnight run.

- [ ] **Step 1: Run a single eval**

Run:
```bash
pnpm eval --tasks cli-help-flag --condition with --reps 1
```
Expected: completes within 5 minutes, prints one row in the results table, writes JSON to `benchmarks/eval/results/`.

- [ ] **Step 2: Run the "without" condition**

Run:
```bash
pnpm eval --tasks cli-help-flag --condition without --reps 1
```
Expected: completes, prints one row. Exploration calls should be higher than the "with" run.

- [ ] **Step 3: Verify JSON report was written**

Run: `ls benchmarks/eval/results/`
Expected: 2 JSON files from the two runs above.

- [ ] **Step 4: Run both conditions together**

Run:
```bash
pnpm eval --tasks cli-help-flag --reps 1
```
Expected: prints 2 rows (with + without) and a summary delta table.

- [ ] **Step 5: Commit any fixes if needed**

Only commit if the dry run revealed issues that needed fixing.
