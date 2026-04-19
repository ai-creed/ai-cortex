// benchmarks/lib/measure.test.ts
import { describe, it, expect } from "vitest";
import { measureN } from "./measure.js";

describe("measureN", () => {
	it("returns correct stats for a deterministic function", async () => {
		let callCount = 0;
		const fn = async () => {
			callCount++;
		};

		const result = await measureN(fn, { warmup: 2, runs: 10 });

		expect(callCount).toBe(12); // 2 warmup + 10 measured
		expect(result.runs).toBe(10);
		expect(result.p50).toBeGreaterThanOrEqual(0);
		expect(result.p95).toBeGreaterThanOrEqual(result.p50);
		expect(result.min).toBeLessThanOrEqual(result.p50);
		expect(result.max).toBeGreaterThanOrEqual(result.p95);
	});

	it("measures actual elapsed time", async () => {
		const fn = async () => {
			const start = performance.now();
			while (performance.now() - start < 5) {
				// busy-wait ~5ms
			}
		};

		const result = await measureN(fn, { warmup: 1, runs: 5 });

		expect(result.p50).toBeGreaterThanOrEqual(4);
		expect(result.p50).toBeLessThan(50);
	});

	it("calls beforeEach before each measured run", async () => {
		let beforeCount = 0;
		const runOrder: string[] = [];
		const fn = async () => { runOrder.push("run"); };
		const beforeEach = async () => { beforeCount++; runOrder.push("before"); };

		await measureN(fn, { warmup: 1, runs: 3, beforeEach });

		expect(beforeCount).toBe(3); // only measured runs, not warmup
		// Verify interleaving: before-run-before-run-before-run
		const measuredOrder = runOrder.slice(-6); // skip warmup
		expect(measuredOrder).toEqual(["before", "run", "before", "run", "before", "run"]);
	});
});
