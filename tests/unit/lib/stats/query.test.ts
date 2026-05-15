// tests/unit/lib/stats/query.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { closeAllSinks } from "../../../../src/lib/stats/registry.js";
import { aggregate } from "../../../../src/lib/stats/query.js";

const repoKey = "71756572790000aa";
let tmp: string;
let originalCacheHome: string | undefined;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stats-query-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	closeAllSinks();
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(events: Array<Parameters<typeof writeEvent>[1]>) {
	const sink = openSink(repoKey);
	for (const e of events) writeEvent(sink, e);
	sink.close();
}

describe("aggregate", () => {
	it("returns zeros when no rows in window", () => {
		seed([]);
		const a = aggregate(repoKey, "7d");
		expect(a).toEqual({
			total: 0,
			errs: 0,
			p50: 0,
			p95: 0,
			cache_status: { fresh: 0, reindexed: 0, stale: 0 },
		});
	});

	it("computes total, errors, and cache mix", () => {
		const now = Date.now();
		seed([
			{ ts: now, tool: "suggest_files", dur_ms: 10, status: "ok", cache_status: "fresh" },
			{ ts: now, tool: "suggest_files", dur_ms: 20, status: "ok", cache_status: "fresh" },
			{ ts: now, tool: "suggest_files", dur_ms: 30, status: "error" },
			{ ts: now, tool: "suggest_files", dur_ms: 40, status: "ok", cache_status: "reindexed" },
		]);
		const a = aggregate(repoKey, "7d");
		expect(a.total).toBe(4);
		expect(a.errs).toBe(1);
		expect(a.cache_status.fresh).toBe(2);
		expect(a.cache_status.reindexed).toBe(1);
		expect(a.cache_status.stale).toBe(0);
	});

	it("computes p50/p95 over dur_ms", () => {
		const now = Date.now();
		seed(
			Array.from({ length: 100 }, (_, i) => ({
				ts: now,
				tool: "x",
				dur_ms: i + 1,
				status: "ok" as const,
			})),
		);
		const a = aggregate(repoKey, "7d");
		expect(a.p50).toBe(50);
		expect(a.p95).toBe(95);
	});

	it("excludes rows outside the window", () => {
		const now = Date.now();
		const ancient = now - 8 * 24 * 60 * 60 * 1000;
		seed([
			{ ts: ancient, tool: "x", dur_ms: 1, status: "ok" },
			{ ts: now, tool: "x", dur_ms: 2, status: "ok" },
		]);
		const a = aggregate(repoKey, "7d");
		expect(a.total).toBe(1);
	});
});
