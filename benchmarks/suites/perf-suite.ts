// benchmarks/suites/perf-suite.ts
import fs from "node:fs";
import path from "node:path";
import { indexRepo } from "../../src/lib/indexer.js";
import { rehydrateRepo } from "../../src/lib/rehydrate.js";
import { suggestRepo } from "../../src/lib/suggest.js";
import { queryBlastRadius } from "../../src/lib/blast-radius.js";
import { getCacheDir } from "../../src/lib/cache-store.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import type { RepoCache } from "../../src/lib/models.js";
import { measureN } from "../lib/measure.js";
import { checkRegression, checkSlo, loadBaselines } from "../lib/compare.js";
import { getSloForScenario, getConfig } from "../config.js";
import type {
	RepoConfig,
	ScenarioName,
	ScenarioResult,
	RegressionStatus,
} from "../lib/types.js";

function clearCache(repoPath: string): void {
	const identity = resolveRepoIdentity(repoPath);
	const dir = getCacheDir(identity.repoKey);
	if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

async function ensureCache(repoPath: string): Promise<void> {
	await indexRepo(repoPath);
}

function addUntrackedFile(repoPath: string): string {
	const filePath = path.join(repoPath, "__bench_untracked__.tmp");
	fs.writeFileSync(filePath, "// bench stale marker\n");
	return filePath;
}

function removeUntrackedFile(filePath: string): void {
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

type ScenarioRunner = {
	name: ScenarioName;
	setup: (repoPath: string) => Promise<void> | void;
	run: (repoPath: string) => Promise<void>;
	beforeEach?: (repoPath: string) => Promise<void> | void;
	teardown?: (repoPath: string) => void;
};

function buildScenarios(): ScenarioRunner[] {
	let staleMarkerPath = "";
	let blastCache: RepoCache | null = null;
	let blastTarget: { qualifiedName: string; file: string } | null = null;

	return [
		{
			name: "index:cold",
			setup: () => {},
			// beforeEach clears cache so every measured run is a true cold index
			beforeEach: (repoPath) => {
				clearCache(repoPath);
			},
			run: async (repoPath) => {
				await indexRepo(repoPath);
			},
		},
		{
			name: "rehydrate:warm",
			setup: async (repoPath) => {
				await ensureCache(repoPath);
			},
			run: async (repoPath) => {
				await rehydrateRepo(repoPath);
			},
		},
		{
			name: "rehydrate:stale",
			setup: () => {},
			// beforeEach: build clean cache THEN add marker, so rehydrateRepo
			// sees a cache built from a clean worktree + a newly dirty worktree.
			beforeEach: async (repoPath) => {
				removeUntrackedFile(staleMarkerPath);
				clearCache(repoPath);
				await ensureCache(repoPath); // cache built from clean worktree
				staleMarkerPath = addUntrackedFile(repoPath); // now worktree is dirty
			},
			run: async (repoPath) => {
				await rehydrateRepo(repoPath);
			},
			teardown: () => {
				removeUntrackedFile(staleMarkerPath);
			},
		},
		{
			name: "suggest:warm",
			setup: async (repoPath) => {
				await ensureCache(repoPath);
			},
			run: async (repoPath) => {
				await suggestRepo(repoPath, "fix the authentication logic");
			},
		},
		{
			name: "blastRadius:warm",
			setup: async (repoPath) => {
				await ensureCache(repoPath);
				// Capture cache and target once — only queryBlastRadius is timed
				const { cache } = await rehydrateRepo(repoPath, { stale: true });
				blastCache = cache;
				blastTarget =
					cache.functions.length > 0
						? {
								qualifiedName: cache.functions[0].qualifiedName,
								file: cache.functions[0].file,
							}
						: null;
			},
			run: async () => {
				if (blastTarget && blastCache) {
					queryBlastRadius(blastTarget, blastCache.calls, blastCache.functions);
				}
			},
		},
	];
}

export type PerfSuiteOptions = {
	repos: RepoConfig[];
	baselinesPath: string;
	scenarios?: ScenarioName[];
	fast?: boolean;
};

export async function runPerfSuite(
	options: PerfSuiteOptions,
): Promise<ScenarioResult[]> {
	const config = getConfig({ fast: options.fast });
	const baselines = loadBaselines(options.baselinesPath);
	const allScenarios = buildScenarios();
	const selectedScenarios = options.scenarios
		? allScenarios.filter((s) => options.scenarios!.includes(s.name))
		: allScenarios;

	const results: ScenarioResult[] = [];

	for (const repo of options.repos) {
		for (const scenario of selectedScenarios) {
			process.stderr.write(`  ${repo.name} / ${scenario.name}...\n`);

			await scenario.setup(repo.path);

			const timing = await measureN(() => scenario.run(repo.path), {
				...config.measurement,
				beforeEach: scenario.beforeEach
					? async () => {
							await scenario.beforeEach!(repo.path);
						}
					: undefined,
			});

			scenario.teardown?.(repo.path);

			const slo = getSloForScenario(scenario.name, repo.sizeBucket);
			const baselineP50 = baselines[repo.name]?.[scenario.name] ?? null;
			const regression = checkRegression(
				timing.p50,
				baselineP50,
				config.thresholds,
			);
			const sloPass = checkSlo(timing.p50, slo);

			let status: RegressionStatus = regression.status;
			if (!sloPass) status = "fail";

			results.push({
				repo: repo.name,
				scenario: scenario.name,
				timing,
				slo,
				baseline: baselineP50,
				regressionPct: regression.pct,
				status,
			});
		}
	}

	return results;
}
