// benchmarks/suites/quality-suite.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { indexRepo } from "../../src/lib/indexer.js";
import { suggestRepo } from "../../src/lib/suggest.js";
import { queryBlastRadius } from "../../src/lib/blast-radius.js";
import { rehydrateRepo } from "../../src/lib/rehydrate.js";
import { RANKING_ASSERTIONS } from "../config.js";
import type {
	RepoConfig,
	QualityResult,
	SuggestQualityResult,
	BlastRadiusQualityResult,
	RankingQualityResult,
} from "../lib/types.js";

type GoldenSuggest = {
	task: string;
	expected: string[];
	limit: number;
};

type GoldenBlastHit = {
	qualifiedName: string;
	file: string;
	hop: number;
};

type GoldenBlastRadius = {
	function: string;
	file: string;
	minConfidence: "full" | "partial";
	expectedHits: GoldenBlastHit[];
};

type GoldenSets = {
	suggest: GoldenSuggest[];
	blastRadius: GoldenBlastRadius[];
};

function loadGoldenSets(fixtureDir: string): GoldenSets {
	const filePath = path.join(fixtureDir, "golden-sets.json");
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as GoldenSets;
}

async function runSuggestGoldenSets(
	repoPath: string,
	goldenSets: GoldenSuggest[],
): Promise<SuggestQualityResult[]> {
	const results: SuggestQualityResult[] = [];

	for (const gs of goldenSets) {
		const result = await suggestRepo(repoPath, gs.task, { limit: gs.limit });
		const returnedPaths = result.results.map((r) => r.path);

		const hits = gs.expected.filter((e) => returnedPaths.includes(e));
		const precision =
			returnedPaths.length > 0 ? hits.length / returnedPaths.length : 0;
		const recall =
			gs.expected.length > 0 ? hits.length / gs.expected.length : 0;

		results.push({
			suite: "golden-set",
			name: gs.task,
			precision: Math.round(precision * 100) / 100,
			recall: Math.round(recall * 100) / 100,
			status: precision >= 0.6 && recall >= 0.6 ? "pass" : "fail",
		});
	}

	return results;
}

async function runBlastRadiusGoldenSets(
	repoPath: string,
	goldenSets: GoldenBlastRadius[],
): Promise<BlastRadiusQualityResult[]> {
	const results: BlastRadiusQualityResult[] = [];
	const { cache } = await rehydrateRepo(repoPath, { stale: true });

	for (const gs of goldenSets) {
		const result = queryBlastRadius(
			{ qualifiedName: gs.function, file: gs.file },
			cache.calls,
			cache.functions,
		);

		const allHits = result.tiers.flatMap((t) =>
			t.hits.map((h) => ({
				qualifiedName: h.qualifiedName,
				file: h.file,
				hop: t.hop,
			})),
		);

		let found = 0;
		for (const expected of gs.expectedHits) {
			const match = allHits.some(
				(h) =>
					h.qualifiedName === expected.qualifiedName &&
					h.file === expected.file &&
					h.hop === expected.hop,
			);
			if (match) found++;
		}

		const confidenceOk =
			gs.minConfidence === "partial" || result.confidence === "full";

		results.push({
			suite: "golden-set",
			name: `blast: ${gs.function}`,
			hitsFound: found,
			hitsExpected: gs.expectedHits.length,
			confidence: result.confidence,
			minConfidence: gs.minConfidence,
			status:
				found === gs.expectedHits.length && confidenceOk ? "pass" : "fail",
		});
	}

	return results;
}

async function runRankingAssertions(
	repos: RepoConfig[],
): Promise<RankingQualityResult[]> {
	const results: RankingQualityResult[] = [];

	for (const repo of repos) {
		const assertions = RANKING_ASSERTIONS[repo.name];
		if (!assertions) continue;

		for (const assertion of assertions) {
			const result = await suggestRepo(repo.path, assertion.task);
			const paths = result.results.map((r) => r.path);

			let pairsPass = 0;
			for (const [higher, lower] of assertion.higherThan) {
				const higherIdx = paths.indexOf(higher);
				const lowerIdx = paths.indexOf(lower);
				// higher must appear before lower (lower index = higher rank)
				// if higher is found and lower is not found, that counts as pass
				// if neither found, count as fail
				if (higherIdx >= 0 && (lowerIdx < 0 || higherIdx < lowerIdx)) {
					pairsPass++;
				}
			}

			results.push({
				suite: "ranking",
				name: `${repo.name}: ${assertion.task}`,
				pairsPass,
				pairsTotal: assertion.higherThan.length,
				status: pairsPass === assertion.higherThan.length ? "pass" : "fail",
			});
		}
	}

	return results;
}

export type QualitySuiteOptions = {
	repos: RepoConfig[];
	syntheticRepoPath: string;
	goldenSetsDir: string;
};

export async function runQualitySuite(
	options: QualitySuiteOptions,
): Promise<QualityResult[]> {
	const goldenSets = loadGoldenSets(options.goldenSetsDir);
	const results: QualityResult[] = [];

	// Initialize nested .git if absent (source files are committed, .git is gitignored)
	const gitDir = path.join(options.syntheticRepoPath, ".git");
	if (!fs.existsSync(gitDir)) {
		process.stderr.write("  initializing synthetic repo git...\n");
		execFileSync("git", ["init"], {
			cwd: options.syntheticRepoPath,
			stdio: "ignore",
		});
		execFileSync("git", ["add", "."], {
			cwd: options.syntheticRepoPath,
			stdio: "ignore",
		});
		execFileSync("git", ["commit", "-m", "initial"], {
			cwd: options.syntheticRepoPath,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "bench",
				GIT_AUTHOR_EMAIL: "bench@test",
				GIT_COMMITTER_NAME: "bench",
				GIT_COMMITTER_EMAIL: "bench@test",
			},
		});
	}

	// Index synthetic repo first
	process.stderr.write("  indexing synthetic repo...\n");
	await indexRepo(options.syntheticRepoPath);

	// Golden set: suggest
	process.stderr.write("  running suggest golden sets...\n");
	const suggestResults = await runSuggestGoldenSets(
		options.syntheticRepoPath,
		goldenSets.suggest,
	);
	results.push(...suggestResults);

	// Golden set: blast radius
	process.stderr.write("  running blast radius golden sets...\n");
	const blastResults = await runBlastRadiusGoldenSets(
		options.syntheticRepoPath,
		goldenSets.blastRadius,
	);
	results.push(...blastResults);

	// Ranking assertions on real repos
	process.stderr.write("  running ranking assertions...\n");
	const rankingResults = await runRankingAssertions(options.repos);
	results.push(...rankingResults);

	return results;
}
