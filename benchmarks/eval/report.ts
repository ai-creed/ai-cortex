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
			if (b === 0) return a === 0 ? "n/a" : "+inf";
			const pct = Math.round(((a - b) / b) * 100);
			return `${pct > 0 ? "+" : ""}${pct}%`;
		};

		console.log("\n── Summary ─────────────────────────────────────────────────────────────\n");
		console.log(`  ${pad("", 24)}${pad("With briefing", 20)}${pad("Without briefing", 20)}Delta (+good)`);
		console.log(`  ${pad("Exploration calls", 24)}${pad(wExplore.toFixed(1) + " avg", 20)}${pad(woExplore.toFixed(1) + " avg", 20)}${delta(woExplore, wExplore)}`);
		console.log(`  ${pad("Total tool calls", 24)}${pad(wTotal.toFixed(1) + " avg", 20)}${pad(woTotal.toFixed(1) + " avg", 20)}${delta(woTotal, wTotal)}`);
		console.log(`  ${pad("Wall clock time", 24)}${pad(fmtTime(wTime) + " avg", 20)}${pad(fmtTime(woTime) + " avg", 20)}${delta(woTime, wTime)}`);
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
