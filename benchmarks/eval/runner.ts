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
