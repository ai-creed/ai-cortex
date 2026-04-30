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
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch {
		return false;
	}
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

export function getTouchedFiles(
	worktreePath: string,
	exclude?: Set<string>,
): string[] {
	const run = (args: string[]): string[] => {
		try {
			return execFileSync("git", args, {
				cwd: worktreePath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
				.trimEnd()
				.split("\n")
				.filter((l) => l.length > 0);
		} catch {
			return [];
		}
	};

	const modified = run(["diff", "--name-only", "HEAD"]);
	const untracked = run(["ls-files", "--others", "--exclude-standard"]);
	const all = [...new Set([...modified, ...untracked])];
	return exclude ? all.filter((f) => !exclude.has(f)) : all;
}

export function runVerification(
	task: EvalTask,
	worktreePath: string,
	timeoutMs?: number,
	exclude?: Set<string>,
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
			timeout: timeoutMs ?? 60000,
		});
		verifyPass = true;
	} catch {
		verifyPass = false;
	}

	// Files correctness — exclude harness-created files from scoring
	const touched = getTouchedFiles(worktreePath, exclude);
	const filesCorrect = computeFilesCorrect(task.groundTruthFiles, touched);

	return { structuralPass, verifyPass, filesCorrect };
}
