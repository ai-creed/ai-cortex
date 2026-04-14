// benchmarks/config.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoConfig, ScenarioName, SizeBucket } from "./lib/types.js";

function repoRoot(): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		cwd: path.dirname(new URL(import.meta.url).pathname),
	}).trimEnd();
}

function countIndexableFiles(repoPath: string): number {
	try {
		const output = execFileSync(
			"git",
			["-C", repoPath, "ls-files", "--cached", "--others", "--exclude-standard"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return output
			.split("\n")
			.filter((f) => /\.(ts|tsx|js|jsx)$/u.test(f)).length;
	} catch {
		return 0;
	}
}

function sizeBucket(fileCount: number): SizeBucket {
	if (fileCount < 100) return "small";
	if (fileCount <= 500) return "medium";
	return "large";
}

export type DiscoverOptions = {
	extraRepoPaths?: Record<string, string>;
};

export function discoverRepos(options: DiscoverOptions = {}): RepoConfig[] {
	const repos: RepoConfig[] = [];

	// Self repo — always available
	const selfPath = repoRoot();
	const selfCount = countIndexableFiles(selfPath);
	repos.push({
		name: "ai-cortex",
		path: selfPath,
		required: true,
		sizeBucket: sizeBucket(selfCount),
	});

	// Extra repos from options or BENCH_REPOS env var
	const envRepos = process.env.BENCH_REPOS;
	const extraPaths: Record<string, string> = { ...options.extraRepoPaths };

	if (envRepos) {
		for (const entry of envRepos.split(",")) {
			const trimmed = entry.trim();
			if (!trimmed) continue;
			const resolved = path.resolve(trimmed.replace(/^~/, os.homedir()));
			extraPaths[path.basename(resolved)] = resolved;
		}
	}

	// Default optional repos
	const defaultOptional: Record<string, string> = {
		"ai-samantha": path.join(os.homedir(), "Dev", "ai-samantha"),
		"ai-14all": path.join(os.homedir(), "Dev", "ai-14all"),
		"ai-whisper": path.join(os.homedir(), "Dev", "ai-whisper"),
	};

	for (const [name, repoPath] of Object.entries({ ...defaultOptional, ...extraPaths })) {
		if (name === "ai-cortex") continue; // already added
		if (!fs.existsSync(repoPath)) {
			process.stderr.write(`bench: skipping ${name} (not found at ${repoPath})\n`);
			continue;
		}
		const count = countIndexableFiles(repoPath);
		repos.push({
			name,
			path: repoPath,
			required: false,
			sizeBucket: sizeBucket(count),
		});
	}

	return repos;
}

const SLO_TABLE: Record<string, Record<SizeBucket, number> | null> = {
	"index:cold": { small: 200, medium: 500, large: 2000 },
	"rehydrate:warm": { small: 20, medium: 50, large: 200 },
	"rehydrate:stale": null,
	"suggest:warm": { small: 50, medium: 100, large: 500 },
	"blastRadius:warm": { small: 50, medium: 100, large: 500 },
};

export function getSloForScenario(
	scenario: ScenarioName,
	bucket: SizeBucket,
): number | null {
	const entry = SLO_TABLE[scenario];
	if (!entry) return null;
	return entry[bucket];
}

export type RankingAssertion = {
	task: string;
	higherThan: [string, string][];
};

export const RANKING_ASSERTIONS: Record<string, RankingAssertion[]> = {
	"ai-cortex": [
		{
			task: "fix the suggest ranker scoring",
			higherThan: [
				["src/lib/suggest-ranker.ts", "README.md"],
				["src/lib/suggest.ts", "docs/shared/product_brief.md"],
			],
		},
		{
			task: "add a new MCP tool",
			higherThan: [
				["src/mcp/server.ts", "README.md"],
				["src/lib/models.ts", "docs/shared/high_level_plan.md"],
			],
		},
		{
			task: "fix the blast radius BFS traversal",
			higherThan: [
				["src/lib/blast-radius.ts", "README.md"],
				["src/lib/call-graph.ts", "docs/shared/product_brief.md"],
			],
		},
	],
};

export type BenchConfig = {
	thresholds: { warnPct: number; failPct: number };
	measurement: { warmup: number; runs: number };
};

export function getConfig(options?: { fast?: boolean }): BenchConfig {
	if (options?.fast) {
		return {
			thresholds: { warnPct: 10, failPct: 20 },
			measurement: { warmup: 1, runs: 3 },
		};
	}
	return {
		thresholds: { warnPct: 10, failPct: 20 },
		measurement: { warmup: 3, runs: 20 },
	};
}
