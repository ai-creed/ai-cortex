import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { indexDbPath } from "../../../../src/lib/memory/paths.js";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { closeAllSinks } from "../../../../src/lib/stats/registry.js";
import { memoryActivity } from "../../../../src/lib/stats/query.js";

const repoKey = "6163746976697479";
let originalCacheHome: string | undefined;
let tmp: string;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-activity-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	closeAllSinks();
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function seedAudit(tsList: string[]) {
	fs.mkdirSync(path.dirname(indexDbPath(repoKey)), { recursive: true });
	const db = new Database(indexDbPath(repoKey));
	db.exec(
		"CREATE TABLE memory_audit (memory_id TEXT, version INTEGER, ts TEXT, change_type TEXT, PRIMARY KEY(memory_id,version));",
	);
	const ins = db.prepare(
		"INSERT INTO memory_audit (memory_id,version,ts,change_type) VALUES (?,?,?,?)",
	);
	tsList.forEach((ts, i) => ins.run(`m${i}`, 1, ts, "create"));
	// a non-create row that must be ignored
	ins.run("x", 2, tsList[0] ?? new Date().toISOString(), "update");
	db.close();
}

describe("memoryActivity", () => {
	it("all-zero when both sources absent", () => {
		const a = memoryActivity(repoKey, "7d");
		expect(a.buckets).toBe(30);
		expect(a.recorded).toHaveLength(30);
		expect(a.used).toHaveLength(30);
		expect(a.recordedTotal).toBe(0);
		expect(a.usedTotal).toBe(0);
		expect(a.recorded.every((n) => n === 0)).toBe(true);
		expect(a.used.every((n) => n === 0)).toBe(true);
	});

	it("counts audit create events (ISO ts) into recorded; ignores non-create", () => {
		const now = Date.now();
		seedAudit([
			new Date(now - 2 * 3600_000).toISOString(),
			new Date(now - 1 * 3600_000).toISOString(),
			new Date(now - 9 * 24 * 3600_000).toISOString(), // outside 7d window
		]);
		const a = memoryActivity(repoKey, "7d");
		expect(a.recordedTotal).toBe(2);
		expect(a.recorded.reduce((x, y) => x + y, 0)).toBe(2);
		expect(a.usedTotal).toBe(0);
	});

	it("counts get_memory/recall_memory sink rows into used (integer ms ts)", () => {
		const now = Date.now();
		const sink = openSink(repoKey);
		writeEvent(sink, { ts: now - 1000, tool: "get_memory", dur_ms: 1, status: "ok" });
		writeEvent(sink, { ts: now - 2000, tool: "recall_memory", dur_ms: 1, status: "ok" });
		writeEvent(sink, { ts: now - 3000, tool: "suggest_files", dur_ms: 1, status: "ok" });
		sink.close();
		const a = memoryActivity(repoKey, "7d");
		expect(a.usedTotal).toBe(2);
		expect(a.recordedTotal).toBe(0);
	});

	it("a missing events.sqlite does not zero recorded (and vice-versa)", () => {
		const now = Date.now();
		seedAudit([new Date(now - 3600_000).toISOString()]);
		const a = memoryActivity(repoKey, "7d");
		expect(a.recordedTotal).toBe(1);
		expect(a.usedTotal).toBe(0);
	});

	it("excludes future-dated rows (clock skew / backfill) from both series", () => {
		const now = Date.now();
		// One legit in-window create + one future-dated create (2 days ahead).
		seedAudit([
			new Date(now - 3600_000).toISOString(),
			new Date(now + 2 * 24 * 3600_000).toISOString(),
		]);
		const sink = openSink(repoKey);
		writeEvent(sink, { ts: now - 1000, tool: "get_memory", dur_ms: 1, status: "ok" });
		writeEvent(sink, {
			ts: now + 2 * 24 * 3600_000,
			tool: "recall_memory",
			dur_ms: 1,
			status: "ok",
		});
		sink.close();
		const a = memoryActivity(repoKey, "7d");
		// Future-dated rows are excluded entirely: without the upper bound +
		// bucketOf reject, each total would be 2 (the future row clamped into
		// the last bucket). The legit in-window row still counts.
		expect(a.recordedTotal).toBe(1);
		expect(a.usedTotal).toBe(1);
	});
});
