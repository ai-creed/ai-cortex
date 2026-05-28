import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
	EMPTY_ADOPTION,
	adoptionAcross,
	_adoptionInternals,
} from "../../../../src/lib/stats/sessions.js";

describe("adoptionAcross", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-adopt-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
		vi.restoreAllMocks();
	});

	it("returns EMPTY_ADOPTION for empty input", () => {
		expect(adoptionAcross([], "7d")).toEqual(EMPTY_ADOPTION);
	});

	it("sums sessionCount, memory-used count, AND recall buckets across repos (asserts recallToGetPct)", () => {
		const spy = vi
			.spyOn(_adoptionInternals, "load")
			.mockImplementation((rk) => {
				if (rk === "aaaaaaaaaaaaaaaa") {
					return {
						sessions: [],
						summary: {
							sessionCount: 4,
							memoryUsedPct: 50,
							recallToGetPct: 50,
							sessionsRecalled: 2,
							sessionsRecallToGet: 1,
							surfaceToGetPct: 0,
							extractCleanupPct: 0,
							unattributedShare: 0,
							histogram: { used: 2, notUsed: 2 },
						},
					};
				}
				if (rk === "bbbbbbbbbbbbbbbb") {
					return {
						sessions: [],
						summary: {
							sessionCount: 6,
							memoryUsedPct: 100,
							recallToGetPct: 100,
							sessionsRecalled: 3,
							sessionsRecallToGet: 3,
							surfaceToGetPct: 0,
							extractCleanupPct: 0,
							unattributedShare: 0,
							histogram: { used: 6, notUsed: 0 },
						},
					};
				}
				throw new Error("unexpected key " + rk);
			});

		const out = adoptionAcross(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"], "7d");
		expect(out.summary.sessionCount).toBe(10);
		expect(out.summary.histogram).toEqual({ used: 8, notUsed: 2 });
		expect(out.summary.memoryUsedPct).toBeCloseTo(80, 5);
		expect(out.summary.sessionsRecalled).toBe(5);
		expect(out.summary.sessionsRecallToGet).toBe(4);
		expect(out.summary.recallToGetPct).toBeCloseTo(80, 5);
		spy.mockRestore();
	});

	it("one repo throwing does not sink the aggregate; surviving buckets still sum", () => {
		const spy = vi
			.spyOn(_adoptionInternals, "load")
			.mockImplementation((rk) => {
				if (rk === "bad0000000000000") throw new Error("boom");
				return {
					sessions: [],
					summary: {
						sessionCount: 2,
						memoryUsedPct: 100,
						recallToGetPct: 50,
						sessionsRecalled: 2,
						sessionsRecallToGet: 1,
						surfaceToGetPct: 0,
						extractCleanupPct: 0,
						unattributedShare: 0,
						histogram: { used: 2, notUsed: 0 },
					},
				};
			});
		const out = adoptionAcross(["bad0000000000000", "1111111111111111"], "7d");
		expect(out.summary.sessionCount).toBe(2);
		expect(out.summary.sessionsRecalled).toBe(2);
		expect(out.summary.sessionsRecallToGet).toBe(1);
		expect(out.summary.recallToGetPct).toBeCloseTo(50, 5);
		spy.mockRestore();
	});
});
