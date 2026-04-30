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
	dryRun: boolean;
} {
	let reps = 3;
	let taskFilter: string | null = null;
	let condition: "both" | "with" | "without" = "both";
	let dryRun = false;

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--reps" && argv[i + 1]) {
			const parsed = parseInt(argv[++i], 10);
			if (isNaN(parsed) || parsed < 1) {
				console.error(`Invalid --reps value: ${argv[i]}`);
				process.exit(1);
			}
			reps = parsed;
		} else if (arg === "--tasks" && argv[i + 1]) {
			taskFilter = argv[++i];
		} else if (arg === "--condition" && argv[i + 1]) {
			const val = argv[++i];
			if (val !== "with" && val !== "without" && val !== "both") {
				console.error(
					`Invalid --condition value: ${val}. Must be "with", "without", or "both".`,
				);
				process.exit(1);
			}
			condition = val;
		} else if (arg === "--dry-run") {
			dryRun = true;
		}
	}

	return { reps, taskFilter, condition, dryRun };
}

function pad(str: string, len: number): string {
	return str.padEnd(len);
}

function printDryRun(
	tasks: ReturnType<typeof getEvalTasks>,
	conditions: Array<"with" | "without">,
	reps: number,
): boolean {
	const totalRuns = tasks.length * conditions.length * reps;
	console.log("ai-cortex evaluation harness [DRY RUN]\n");
	console.log(`Tasks: ${tasks.map((t) => t.name).join(", ")}`);
	console.log(`Conditions: ${conditions.join(", ")}`);
	console.log(`Reps: ${reps}`);
	console.log(`Total runs: ${totalRuns}\n`);

	let allExist = true;
	for (const task of tasks) {
		const exists = fs.existsSync(task.repoPath);
		if (!exists) allExist = false;
		const marker = exists ? "✓" : "✗ (not found)";
		console.log(
			`  ${pad(task.name, 24)}${pad(task.repo, 12)}${pad(task.repoPath, 44)}${marker}`,
		);
	}

	console.log("\nNo agents spawned.");
	return allExist;
}

const RESULTS_DIR = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"results",
);

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	const conditions: Array<"with" | "without"> =
		args.condition === "both" ? ["with", "without"] : [args.condition];

	// Load all tasks, apply only the name filter (not the repo-existence filter)
	let tasks = getEvalTasks();
	if (args.taskFilter) {
		tasks = tasks.filter((t) => t.name === args.taskFilter);
		if (tasks.length === 0) {
			console.error(`No task found matching: ${args.taskFilter}`);
			process.exit(1);
		}
	}

	// Dry-run: print preview table using unfiltered task list, then exit
	if (args.dryRun) {
		const allExist = printDryRun(tasks, conditions, args.reps);
		process.exit(allExist ? 0 : 1);
	}

	console.log("ai-cortex evaluation harness\n");

	// For real runs, filter out tasks whose repo doesn't exist
	tasks = tasks.filter((t) => {
		if (fs.existsSync(t.repoPath)) return true;
		console.error(`Skipping ${t.name}: repo not found at ${t.repoPath}`);
		return false;
	});
	if (tasks.length === 0) {
		console.error("No tasks to run.");
		process.exit(1);
	}

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
