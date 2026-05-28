import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAll } from "../../../src/tui/readAll.js";
import { cacheRoot } from "../../../src/lib/stats/paths.js";
import { _resetStorageCacheForTest } from "../../../src/lib/stats/query.js";
import * as sessionsMod from "../../../src/lib/stats/sessions.js";
import * as queryMod from "../../../src/lib/stats/query.js";

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("readAll overview", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-readall-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(path.join(cacheRoot(), A), { recursive: true });
		fs.mkdirSync(path.join(cacheRoot(), B), { recursive: true });
		_resetStorageCacheForTest();
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
		vi.restoreAllMocks();
	});

	it("focus=null calls adoptionAcross with every listed repoKey (not EMPTY_ADOPTION)", () => {
		const spy = vi.spyOn(sessionsMod, "adoptionAcross").mockReturnValue({
			sessions: [],
			summary: {
				sessionCount: 7,
				memoryUsedPct: 71.42857,
				recallToGetPct: 60,
				sessionsRecalled: 5,
				sessionsRecallToGet: 3,
				surfaceToGetPct: 0,
				extractCleanupPct: 0,
				unattributedShare: 0,
				histogram: { used: 5, notUsed: 2 },
			},
		});

		const snap = readAll("7d", null);

		expect(spy).toHaveBeenCalledTimes(1);
		const [keysArg, windowArg] = spy.mock.calls[0];
		expect(new Set(keysArg)).toEqual(new Set([A, B]));
		expect(windowArg).toBe("7d");

		expect(snap.adoption.summary.sessionCount).toBe(7);
		expect(snap.adoption.summary.sessionsRecalled).toBe(5);
		expect(snap.adoption.summary.sessionsRecallToGet).toBe(3);
		expect(snap.adoption.summary.memoryUsedPct).toBeCloseTo(71.42857, 3);
	});

	it("focus=null computes suggestHit from summed counts across repos", () => {
		const spy = vi
			.spyOn(queryMod, "suggestHitCounts")
			.mockImplementation((rk) =>
				rk === A ? { hits: 6, total: 10 } : { hits: 2, total: 5 },
			);
		const snap = readAll("7d", null);
		expect(snap.suggestHit).toBeCloseTo(8 / 15, 5);
		spy.mockRestore();
	});

	it("suggestHit returns 0 when no suggest_files calls exist anywhere", () => {
		vi.spyOn(queryMod, "suggestHitCounts").mockReturnValue({ hits: 0, total: 0 });
		const snap = readAll("7d", null);
		expect(snap.suggestHit).toBe(0);
	});
});
