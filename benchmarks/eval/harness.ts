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

// Writes a minimal CLAUDE.md into the worktree root so the spawned agent
// ignores the user's global ~/.claude/CLAUDE.md and its approval gates.
function writeEvalClaudeMd(worktreePath: string): void {
	const content = [
		"You are running in an automated evaluation harness.",
		"Proceed directly with all implementation.",
		"Do not ask for approval, do not ask clarifying questions, do not invoke any skills.",
		"Make all changes immediately and completely.",
	].join(" ");
	fs.writeFileSync(path.join(worktreePath, "CLAUDE.md"), content + "\n");
}

function mainRepoCli(): string {
	const evalDir = path.dirname(new URL(import.meta.url).pathname);
	const repoRoot = path.resolve(evalDir, "..", "..");
	return path.join(repoRoot, "dist", "src", "cli.js");
}

function generateBriefing(worktreePath: string): string {
	const result = spawnSync(
		"node",
		[mainRepoCli(), "rehydrate", worktreePath, "--json"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 },
	);

	// Always log stderr when present — often contains the actionable error reason
	if (result.stderr?.trim()) {
		process.stderr.write(`  [briefing] rehydrate stderr: ${result.stderr.trim()}\n`);
	}

	// Log non-clean exits (timeout sets signal="SIGTERM", spawn failure sets error)
	if (result.status !== 0 || result.signal || result.error) {
		const parts = [
			result.status !== null ? `status=${result.status}` : null,
			result.signal ? `signal=${result.signal}` : null,
			result.error ? `error=${result.error.message}` : null,
		].filter(Boolean).join(" ");
		process.stderr.write(`  [briefing] rehydrate failed: ${parts}\n`);
		return "";
	}

	if (!result.stdout) {
		process.stderr.write("  [briefing] empty stdout from rehydrate\n");
		return "";
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
	} catch {
		process.stderr.write("  [briefing] unexpected rehydrate output\n");
		return "";
	}

	const briefingPath = json["briefingPath"] as string | undefined;
	if (typeof briefingPath !== "string") {
		process.stderr.write("  [briefing] unexpected rehydrate output\n");
		return "";
	}

	try {
		return fs.readFileSync(briefingPath, "utf8");
	} catch (err) {
		process.stderr.write(`  [briefing] failed to read briefing file: ${(err as Error).message}\n`);
		return "";
	}
}

const FIXTURE_MAP: Record<string, string> = {
	"briefing-doc-limit": "briefing-eval.test.ts",
	"node-framework-detection": "entry-files-eval.test.ts",
};

// Copies a pre-placed fixture test into the worktree so the verify command
// can run it. Returns the repo-relative destination path, or null if this
// task has no fixture.
function copyFixtures(task: EvalTask, worktreePath: string): string | null {
	const fixtureDir = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"fixtures",
	);

	const fixtureFile = FIXTURE_MAP[task.name];
	if (!fixtureFile) return null;

	const src = path.join(fixtureDir, fixtureFile);
	if (!fs.existsSync(src)) return null;

	const destDir = path.join(worktreePath, "tests", "unit", "lib");
	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(src, path.join(destDir, fixtureFile));
	return `tests/unit/lib/${fixtureFile}`;
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
			result.signal === "SIGTERM" || result.error !== null && result.error !== undefined
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
		// 2. Write eval CLAUDE.md to override user's global config
		writeEvalClaudeMd(worktreePath);

		// 3. Copy pre-placed fixtures; get path for exclusion set
		const fixturePath = copyFixtures(task, worktreePath);

		// 4. Build harness-file exclusion set (CLAUDE.md + any placed fixture)
		const harnessFiles = new Set<string>(["CLAUDE.md"]);
		if (fixturePath) harnessFiles.add(fixturePath);

		// 5. Generate briefing from the worktree (ensures briefing matches
		//    exactly the isolated code the agent will see)
		let briefing = "";
		if (condition === "with") {
			briefing = generateBriefing(worktreePath);
		}

		// 6. Build prompt and spawn agent
		const prompt = buildPrompt(task, condition, worktreePath, briefing);
		const agentResult = spawnAgent(prompt, worktreePath, task.timeoutMs);

		// 7. Parse metrics
		const metrics = parseStreamJson(agentResult.stdout);

		// 8. Run verification (excluding harness-created files from scoring)
		const verification = runVerification(task, worktreePath, task.timeoutMs, harnessFiles);

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
		// 9. Cleanup
		removeWorktree(task.repoPath, worktreePath);
	}
}
