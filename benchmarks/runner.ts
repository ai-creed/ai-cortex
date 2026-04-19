// benchmarks/runner.ts
import path from "node:path";
import { discoverRepos } from "./config.js";
import { runPerfSuite } from "./suites/perf-suite.js";
import { runQualitySuite } from "./suites/quality-suite.js";
import { printReport } from "./reporters/terminal.js";
import { writeJsonReport } from "./reporters/json.js";
import { saveBaselines, loadBaselines } from "./lib/compare.js";
import type { SuiteReport } from "./lib/types.js";

function parseArgs(argv: string[]): {
	suite: "all" | "perf" | "quality";
	updateBaseline: boolean;
	json: boolean;
	fast: boolean;
	repoFilter: string | null;
} {
	let suite: "all" | "perf" | "quality" = "all";
	let updateBaseline = false;
	let json = false;
	let fast = false;
	let repoFilter: string | null = null;

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--suite" && argv[i + 1]) {
			suite = argv[++i] as "perf" | "quality";
		} else if (arg === "--update-baseline") {
			updateBaseline = true;
		} else if (arg === "--json") {
			json = true;
		} else if (arg === "--fast") {
			fast = true;
		} else if (arg === "--repo" && argv[i + 1]) {
			repoFilter = argv[++i];
		}
	}

	return { suite, updateBaseline, json, fast, repoFilter };
}

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BASELINES_PATH = path.join(ROOT, "baselines.json");
const RESULTS_PATH = path.join(ROOT, "results.json");
const SYNTHETIC_REPO = path.join(ROOT, "fixtures", "synthetic", "repo");
const GOLDEN_SETS_DIR = path.join(ROOT, "fixtures", "synthetic");

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	console.log("ai-cortex benchmark suite\n");

	let repos = discoverRepos();
	if (args.repoFilter) {
		repos = repos.filter((r) => r.name === args.repoFilter);
		if (repos.length === 0) {
			console.error(`No repo found matching: ${args.repoFilter}`);
			process.exit(1);
		}
	}

	console.log(`Repos: ${repos.map((r) => `${r.name} (${r.sizeBucket})`).join(", ")}\n`);

	const report: SuiteReport = { perf: [], quality: [] };

	if (args.suite === "all" || args.suite === "perf") {
		console.log("Running performance suite...");
		report.perf = await runPerfSuite({
			repos,
			baselinesPath: BASELINES_PATH,
			fast: args.fast,
		});
	}

	if (args.suite === "all" || args.suite === "quality") {
		console.log("Running quality suite...");
		report.quality = await runQualitySuite({
			repos,
			syntheticRepoPath: SYNTHETIC_REPO,
			goldenSetsDir: GOLDEN_SETS_DIR,
		});
	}

	printReport(report);

	if (args.json) {
		writeJsonReport(report, RESULTS_PATH);
	}

	if (args.updateBaseline) {
		const baselines = loadBaselines(BASELINES_PATH);
		for (const r of report.perf) {
			if (!baselines[r.repo]) baselines[r.repo] = {};
			baselines[r.repo][r.scenario] = Math.round(r.timing.p50 * 100) / 100;
		}
		saveBaselines(BASELINES_PATH, baselines);
		console.log(`Baselines updated: ${BASELINES_PATH}`);
	}

	const hasFail =
		report.perf.some((r) => r.status === "fail") ||
		report.quality.some((r) => r.status === "fail");
	process.exit(hasFail ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
