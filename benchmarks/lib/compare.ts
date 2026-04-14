// benchmarks/lib/compare.ts
import fs from "node:fs";
import type { RegressionStatus } from "./types.js";

export type Baselines = Record<string, Record<string, number>>;

export type RegressionThresholds = {
	warnPct: number;
	failPct: number;
};

export type RegressionCheck = {
	status: RegressionStatus;
	pct: number | null;
};

export function checkRegression(
	currentP50: number,
	baselineP50: number | null,
	thresholds: RegressionThresholds,
): RegressionCheck {
	if (baselineP50 === null) return { status: "skip", pct: null };

	const pct = Math.round(((currentP50 - baselineP50) / baselineP50) * 10000) / 100;

	if (pct > thresholds.failPct) return { status: "fail", pct };
	if (pct > thresholds.warnPct) return { status: "warn", pct };
	return { status: "pass", pct };
}

export function checkSlo(currentP50: number, slo: number | null): boolean {
	if (slo === null) return true;
	return currentP50 <= slo;
}

export function loadBaselines(filePath: string): Baselines {
	if (!fs.existsSync(filePath)) return {};
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as Baselines;
}

export function saveBaselines(filePath: string, data: Baselines): void {
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t") + "\n");
}
