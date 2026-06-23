// src/lib/library/__tests__/telemetry.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeO6Metrics,
	downstreamTouch,
	recordSearch,
} from "../telemetry.js";

describe("library telemetry (O6)", () => {
	let cacheHome: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-tel-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(cacheHome, { recursive: true, force: true });
	});

	it("downstreamTouch matches later touches by resolved absolute path", () => {
		expect(downstreamTouch(["/a/b.md"], ["/a/b.md", "/c/d.ts"])).toBe(true);
		expect(downstreamTouch(["/a/b.md"], ["/c/d.ts"])).toBe(false);
		expect(downstreamTouch([], ["/a/b.md"])).toBe(false);
	});

	it("counts only touches that occur later in the same session", async () => {
		// s1: doc returned at turn 2, then the file is opened at turn 5 -> downstream touch.
		recordSearch({
			ts: "2026-06-23T00:00:00Z",
			sessionId: "s1",
			turn: 2,
			query: "cache eviction",
			sourcesQueried: 2,
			currentRepoKey: "repoA",
			hits: [
				{
					sourceId: "src1",
					relPath: "a.md",
					absPath: "/proj/a.md",
					repoKey: "repoA",
				},
				{
					sourceId: "src2",
					relPath: "b.md",
					absPath: "/other/b.md",
					repoKey: "repoB",
				},
			],
		});
		// s2: doc returned at turn 8, but the file was already opened at turn 3 -> NOT downstream.
		recordSearch({
			ts: "2026-06-23T00:01:00Z",
			sessionId: "s2",
			turn: 8,
			query: "token bucket",
			sourcesQueried: 1,
			hits: [{ sourceId: "src1", relPath: "c.md", absPath: "/proj/c.md" }],
		});

		const metrics = await computeO6Metrics({
			sessionFilePaths: async (sid) =>
				sid === "s1"
					? [{ path: "/proj/a.md", turn: 5 }] // after the turn-2 search
					: [{ path: "/proj/c.md", turn: 3 }], // before the turn-8 search
		});
		expect(metrics.searches).toBe(2);
		expect(metrics.returnedNonemptyRate).toBeCloseTo(1); // both returned hits
		// only s1's touch is later than its search; s2's earlier touch does not count.
		expect(metrics.downstreamTouchRate).toBeCloseTo(0.5);
		// 1 of 3 hits is in-repo (s1 a.md repoA matches currentRepoKey).
		expect(metrics.inRepoHitRatio).toBeCloseTo(1 / 3);
	});
});
