// benchmarks/lib/measure.ts
import type { TimingResult } from "./types.js";

export type MeasureOptions = {
	warmup?: number;
	runs?: number;
	beforeEach?: () => Promise<void>;
};

function percentile(sorted: number[], pct: number): number {
	const idx = Math.ceil((pct / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

export async function measureN(
	fn: () => Promise<void>,
	options: MeasureOptions = {},
): Promise<TimingResult> {
	const warmup = options.warmup ?? 3;
	const runs = options.runs ?? 20;

	for (let i = 0; i < warmup; i++) {
		await fn();
	}

	const timings: number[] = [];
	for (let i = 0; i < runs; i++) {
		if (options.beforeEach) await options.beforeEach();
		const start = performance.now();
		await fn();
		timings.push(performance.now() - start);
	}

	const sorted = [...timings].sort((a, b) => a - b);

	return {
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		min: sorted[0],
		max: sorted[sorted.length - 1],
		runs,
	};
}
