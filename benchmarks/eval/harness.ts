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
	// Clean up any stale worktree from a previous crashed run
	try {
		execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
			cwd: repoPath, stdio: "ignore",
		});
	} catch {
		// Not stale, proceed
	}
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

function mainRepoCli(): string {
	const evalDir = path.dirname(new URL(import.meta.url).pathname);
	const repoRoot = path.resolve(evalDir, "..", "..");
	return path.join(repoRoot, "dist", "src", "cli.js");
}

function generateBriefing(repoPath: string): string {
	try {
		const result = spawnSync(
			"node",
			[mainRepoCli(), "rehydrate", repoPath, "--json"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 },
		);
		if (!result.stdout) return "";
		const json = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
		const briefingPath = json["briefingPath"] as string | undefined;
		if (!briefingPath) return "";
		return fs.readFileSync(briefingPath, "utf8");
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
		exitCode:
			result.signal === "SIGTERM" || result.error != null
				? 124
				: (result.status ?? 1),
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
			briefing = generateBriefing(task.repoPath);
		}

		// 4. Build prompt and spawn agent
		const prompt = buildPrompt(task, condition, worktreePath, briefing);
		const agentResult = spawnAgent(prompt, worktreePath, task.timeoutMs);

		// 5. Parse metrics
		const metrics = parseStreamJson(agentResult.stdout);

		// 6. Run verification
		const verification = runVerification(task, worktreePath, task.timeoutMs);

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
