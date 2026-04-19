// benchmarks/reporters/terminal.ts
import type { SuiteReport, ScenarioResult, QualityResult } from "../lib/types.js";

function pad(str: string, len: number): string {
	return str.padEnd(len);
}

function fmtMs(ms: number): string {
	return `${Math.round(ms)}ms`;
}

function fmtStatus(result: ScenarioResult): string {
	switch (result.status) {
		case "pass":
			return "pass";
		case "warn":
			return `warn +${result.regressionPct}%`;
		case "fail": {
			const pctStr = result.regressionPct !== null ? ` ${result.regressionPct > 0 ? "+" : ""}${result.regressionPct}%` : "";
			return `FAIL${pctStr}`;
		}
		case "skip":
			return "pass (no baseline)";
	}
}

function printPerfTable(results: ScenarioResult[]): void {
	console.log("\n── Performance ─────────────────────────────────────────────");
	console.log(
		`  ${pad("repo", 16)}${pad("scenario", 20)}${pad("p50", 10)}${pad("p95", 10)}${pad("SLO", 10)}${pad("baseline", 12)}status`,
	);

	for (const r of results) {
		console.log(
			`  ${pad(r.repo, 16)}${pad(r.scenario, 20)}${pad(fmtMs(r.timing.p50), 10)}${pad(fmtMs(r.timing.p95), 10)}${pad(r.slo !== null ? fmtMs(r.slo) : "—", 10)}${pad(r.baseline !== null ? fmtMs(r.baseline) : "—", 12)}${fmtStatus(r)}`,
		);
	}
}

function fmtQuality(result: QualityResult): string {
	switch (result.suite) {
		case "golden-set": {
			if ("precision" in result) {
				return `${result.status} P@5=${result.precision.toFixed(2)} R@5=${result.recall.toFixed(2)}`;
			}
			return `${result.status} ${result.hitsFound}/${result.hitsExpected} hits, confidence=${result.confidence}`;
		}
		case "ranking":
			return `${result.status} ${result.pairsPass}/${result.pairsTotal} pairs`;
	}
}

function printQualityTable(results: QualityResult[]): void {
	console.log("\n── Quality ─────────────────────────────────────────────────");
	console.log(
		`  ${pad("suite", 14)}${pad("test", 40)}status`,
	);

	for (const r of results) {
		console.log(
			`  ${pad(r.suite, 14)}${pad(r.name, 40)}${fmtQuality(r)}`,
		);
	}
}

export function printReport(report: SuiteReport): void {
	if (report.perf.length > 0) printPerfTable(report.perf);
	if (report.quality.length > 0) printQualityTable(report.quality);

	const perfPass = report.perf.filter((r) => r.status === "pass" || r.status === "skip").length;
	const perfWarn = report.perf.filter((r) => r.status === "warn").length;
	const perfFail = report.perf.filter((r) => r.status === "fail").length;
	const perfSkip = report.perf.filter((r) => r.status === "skip").length;

	const qualPass = report.quality.filter((r) => r.status === "pass").length;
	const qualFail = report.quality.filter((r) => r.status === "fail").length;

	console.log("\n── Summary ─────────────────────────────────────────────────");
	if (report.perf.length > 0) {
		const parts = [`${perfPass}/${report.perf.length} pass`];
		if (perfWarn > 0) parts.push(`${perfWarn} warn`);
		if (perfFail > 0) parts.push(`${perfFail} fail`);
		if (perfSkip > 0) parts.push(`${perfSkip} skip (no baseline)`);
		console.log(`  perf:    ${parts.join(", ")}`);
	}
	if (report.quality.length > 0) {
		const parts = [`${qualPass}/${report.quality.length} pass`];
		if (qualFail > 0) parts.push(`${qualFail} fail`);
		console.log(`  quality: ${parts.join(", ")}`);
	}

	const hasFail = perfFail > 0 || qualFail > 0;
	const hasWarn = perfWarn > 0;
	if (hasFail) {
		console.log("  result:  FAIL");
	} else if (hasWarn) {
		console.log("  result:  PASS (warnings only)");
	} else {
		console.log("  result:  PASS");
	}
	console.log();
}
