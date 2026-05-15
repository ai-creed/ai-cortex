// tests/unit/lib/stats/query.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { closeAllSinks } from "../../../../src/lib/stats/registry.js";
import {
	aggregate,
	topTools,
	latencyPerTool,
	memoryHealth,
	storageFootprint,
	_resetStorageCacheForTest,
	listProjects,
	cacheMeta,
	aggregateAcross,
	memoryHealthAcross,
	toolCounts,
} from "../../../../src/lib/stats/query.js";
import Database from "better-sqlite3";
import { indexDbPath } from "../../../../src/lib/memory/paths.js";
import fsp from "node:fs/promises";

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

describe("topTools", () => {
	it("returns tools sorted by call count desc, with errs", () => {
		const now = Date.now();
		seed([
			{ ts: now, tool: "a", dur_ms: 1, status: "ok" },
			{ ts: now, tool: "a", dur_ms: 1, status: "ok" },
			{ ts: now, tool: "b", dur_ms: 1, status: "error" },
		]);
		expect(topTools(repoKey, "7d", 10)).toEqual([
			{ tool: "a", n: 2, errs: 0 },
			{ tool: "b", n: 1, errs: 1 },
		]);
	});
});

describe("latencyPerTool", () => {
	it("returns p50/p95/samples per tool", () => {
		const now = Date.now();
		const rows = Array.from({ length: 50 }, (_, i) => ({
			ts: now,
			tool: "a",
			dur_ms: i + 1,
			status: "ok" as const,
		}));
		seed(rows);
		const r = latencyPerTool(repoKey, "7d");
		expect(r.a.samples).toBe(50);
		expect(r.a.p50).toBe(25);
		expect(r.a.p95).toBe(47);
	});
});

describe("memoryHealth", () => {
	it("returns counts and top-accessed from memory/index.sqlite", async () => {
		// Bootstrap the memory index by importing schema directly.
		await fsp.mkdir(path.dirname(indexDbPath(repoKey)), { recursive: true });
		const db = new Database(indexDbPath(repoKey));
		db.exec(`
			CREATE TABLE memories (id TEXT, status TEXT, pinned INTEGER, get_count INTEGER, last_accessed_at TEXT);
			INSERT INTO memories VALUES ('a','active',1,5,'2026-05-15');
			INSERT INTO memories VALUES ('b','active',0,12,'2026-05-15');
			INSERT INTO memories VALUES ('c','candidate',0,0,null);
			INSERT INTO memories VALUES ('d','deprecated',0,0,null);
		`);
		db.close();

		const m = memoryHealth(repoKey);
		expect(m.active).toBe(2);
		expect(m.candidate).toBe(1);
		expect(m.pinned).toBe(1);
		expect(m.topAccessed[0]).toEqual({
			id: "b",
			get_count: 12,
			last_accessed_at: "2026-05-15",
		});
	});

	it("returns zeros when memory db missing", () => {
		const m = memoryHealth("ffffffffffffffff");
		expect(m).toEqual({
			active: 0,
			candidate: 0,
			pinned: 0,
			deprecated: 0,
			topAccessed: [],
		});
	});
});

describe("storageFootprint", () => {
	it("returns bytes per repo dir", async () => {
		// Seed a tiny file under repoKey's stats dir.
		await fsp.mkdir(path.join(tmp, repoKey, "stats"), { recursive: true });
		await fsp.writeFile(
			path.join(tmp, repoKey, "stats", "events.sqlite"),
			"x".repeat(100),
		);
		_resetStorageCacheForTest();
		const s = storageFootprint();
		expect(s[repoKey]).toBeGreaterThanOrEqual(100);
	});

	it("caches result for 10s", async () => {
		_resetStorageCacheForTest();
		const s1 = storageFootprint();
		await fsp.mkdir(path.join(tmp, repoKey, "stats"), { recursive: true });
		await fsp.writeFile(
			path.join(tmp, repoKey, "stats", "extra.bin"),
			"y".repeat(500),
		);
		const s2 = storageFootprint();
		// Cached — still old value
		expect(s2[repoKey]).toBe(s1[repoKey]);
	});
});

describe("listProjects", () => {
	it("returns every repoKey with a stats/ subdir", async () => {
		await fsp.mkdir(path.join(tmp, "aaaaaaaaaaaaaaaa", "stats"), {
			recursive: true,
		});
		await fsp.mkdir(path.join(tmp, "bbbbbbbbbbbbbbbb", "stats"), {
			recursive: true,
		});
		await fsp.mkdir(path.join(tmp, "no-stats", "memory"), {
			recursive: true,
		});
		const projects = listProjects();
		expect(projects).toEqual(
			expect.arrayContaining(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]),
		);
		expect(projects).not.toContain("no-stats");
	});

	it("returns empty array when cache root missing", () => {
		process.env.AI_CORTEX_CACHE_HOME = path.join(tmp, "does-not-exist");
		expect(listProjects()).toEqual([]);
	});
});

describe("cacheMeta", () => {
	it("returns indexedAt + fingerprint from the most-recent worktree JSON", async () => {
		await fsp.mkdir(path.join(tmp, repoKey), { recursive: true });
		await fsp.writeFile(
			path.join(tmp, repoKey, "aaaaaaaaaaaaaaaa.json"),
			JSON.stringify({
				indexedAt: "2026-05-14T00:00:00.000Z",
				fingerprint: "older-sha",
				files: [],
			}),
		);
		await fsp.writeFile(
			path.join(tmp, repoKey, "bbbbbbbbbbbbbbbb.json"),
			JSON.stringify({
				indexedAt: "2026-05-15T01:00:00.000Z",
				fingerprint: "newer-sha",
				files: [{}, {}, {}],
			}),
		);
		expect(cacheMeta(repoKey)).toEqual({
			indexedAt: "2026-05-15T01:00:00.000Z",
			fingerprint: "newer-sha",
			fileCount: 3,
		});
	});

	it("returns null fields when no worktree JSON exists", () => {
		expect(cacheMeta("ffffffffffffffff")).toEqual({
			indexedAt: null,
			fingerprint: null,
			fileCount: null,
		});
	});
});

describe("aggregateAcross", () => {
	it("pools dur_ms and counts across multiple repos", () => {
		const rkA = "61".repeat(8);
		const rkB = "62".repeat(8);
		const now = Date.now();
		const sa = openSink(rkA);
		const sb = openSink(rkB);
		for (let i = 1; i <= 50; i++)
			writeEvent(sa, { ts: now, tool: "x", dur_ms: i, status: "ok" });
		for (let i = 51; i <= 100; i++)
			writeEvent(sb, { ts: now, tool: "x", dur_ms: i, status: "ok" });
		sa.close();
		sb.close();

		const agg = aggregateAcross([rkA, rkB], "7d");
		expect(agg.total).toBe(100);
		expect(agg.p50).toBe(50);
		expect(agg.p95).toBe(95);
	});

	it("returns zeros when input is empty", () => {
		const agg = aggregateAcross([], "7d");
		expect(agg.total).toBe(0);
		expect(agg.p50).toBe(0);
	});
});

describe("memoryHealthAcross", () => {
	it("sums counts across repos and unions top-accessed (sorted, capped)", async () => {
		const rkA = "63".repeat(8);
		const rkB = "64".repeat(8);
		await fsp.mkdir(path.dirname(indexDbPath(rkA)), { recursive: true });
		await fsp.mkdir(path.dirname(indexDbPath(rkB)), { recursive: true });
		for (const [rk, mems] of [
			[
				rkA,
				[
					["a1", "active", 0, 10, "2026-05-15"],
					["a2", "candidate", 0, 0, null],
				],
			],
			[rkB, [["b1", "active", 1, 20, "2026-05-15"]]],
		] as const) {
			const db = new Database(indexDbPath(rk));
			db.exec(
				`CREATE TABLE memories (id TEXT, status TEXT, pinned INTEGER, get_count INTEGER, last_accessed_at TEXT);`,
			);
			const ins = db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?)");
			for (const m of mems) ins.run(...m);
			db.close();
		}
		const m = memoryHealthAcross([rkA, rkB]);
		expect(m.active).toBe(2);
		expect(m.candidate).toBe(1);
		expect(m.pinned).toBe(1);
		expect(m.topAccessed[0].id).toBe("b1");
		expect(m.topAccessed[1].id).toBe("a1");
	});
});

describe("toolCounts", () => {
	it("returns per-tool call counts pooled across repos", () => {
		const rkA = "65".repeat(8);
		const rkB = "66".repeat(8);
		const now = Date.now();
		const sa = openSink(rkA);
		const sb = openSink(rkB);
		writeEvent(sa, { ts: now, tool: "recall_memory", dur_ms: 1, status: "ok" });
		writeEvent(sa, { ts: now, tool: "recall_memory", dur_ms: 1, status: "ok" });
		writeEvent(sb, { ts: now, tool: "recall_memory", dur_ms: 1, status: "ok" });
		writeEvent(sb, { ts: now, tool: "get_memory", dur_ms: 1, status: "ok" });
		sa.close();
		sb.close();
		const counts = toolCounts([rkA, rkB], "7d");
		expect(counts.recall_memory).toBe(3);
		expect(counts.get_memory).toBe(1);
	});
});
