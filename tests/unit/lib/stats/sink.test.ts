import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import {
	statsDbPath,
	statsDir,
} from "../../../../src/lib/stats/paths.js";

const padded = "73746174737465".padEnd(16, "0");

let originalCacheHome: string | undefined;
let tmp: string;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stats-sink-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(() => {
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("openSink", () => {
	it("creates the stats dir, events.sqlite, schema v2, and expected columns", () => {
		const sink = openSink(padded);
		try {
			expect(fs.existsSync(statsDir(padded))).toBe(true);
			expect(fs.existsSync(statsDbPath(padded))).toBe(true);

			const version = sink.db.pragma("user_version", {
				simple: true,
			}) as number;
			expect(version).toBe(2);

			const cols = sink.db
				.prepare("PRAGMA table_info(tool_calls)")
				.all() as Array<{ name: string }>;
			expect(cols.map((c) => c.name)).toEqual([
				"ts",
				"tool",
				"dur_ms",
				"status",
				"err_class",
				"err_code",
				"cache_status",
				"mode",
				"result_count",
				"query_len",
				"meta",
				"synthetic",
			]);
		} finally {
			sink.close();
		}
	});

	it("migrates a v1 database to v2 by adding the synthetic column", () => {
		// Hand-craft a v1 database matching the original schema.
		fs.mkdirSync(statsDir(padded), { recursive: true });
		const dbPath = statsDbPath(padded);
		const v1 = new Database(dbPath);
		v1.exec(`
			CREATE TABLE tool_calls (
			  ts            INTEGER NOT NULL,
			  tool          TEXT    NOT NULL,
			  dur_ms        INTEGER NOT NULL,
			  status        TEXT    NOT NULL,
			  err_class     TEXT,
			  err_code      TEXT,
			  cache_status  TEXT,
			  mode          TEXT,
			  result_count  INTEGER,
			  query_len     INTEGER,
			  meta          TEXT
			);
		`);
		v1.prepare(
			"INSERT INTO tool_calls (ts, tool, dur_ms, status) VALUES (?, ?, ?, ?)",
		).run(Date.now(), "legacy_tool", 7, "ok");
		v1.pragma("user_version = 1");
		v1.close();

		const sink = openSink(padded);
		try {
			const version = sink.db.pragma("user_version", {
				simple: true,
			}) as number;
			expect(version).toBe(2);

			const cols = sink.db
				.prepare("PRAGMA table_info(tool_calls)")
				.all() as Array<{ name: string }>;
			expect(cols.map((c) => c.name)).toContain("synthetic");

			// Existing v1 rows preserved with synthetic = 0 by DEFAULT.
			const row = sink.db
				.prepare("SELECT tool, synthetic FROM tool_calls WHERE tool='legacy_tool'")
				.get() as { tool: string; synthetic: number };
			expect(row.tool).toBe("legacy_tool");
			expect(row.synthetic).toBe(0);
		} finally {
			sink.close();
		}
	});
});

describe("writeEvent", () => {
	it("inserts a minimal row with nullable fields null", () => {
		const sink = openSink(padded);
		try {
			writeEvent(sink, {
				ts: 1_700_000_000_000,
				tool: "suggest_files",
				dur_ms: 42,
				status: "ok",
			});
			const row = sink.db
				.prepare("SELECT * FROM tool_calls")
				.get() as Record<string, unknown>;
			expect(row.ts).toBe(1_700_000_000_000);
			expect(row.tool).toBe("suggest_files");
			expect(row.dur_ms).toBe(42);
			expect(row.status).toBe("ok");
			expect(row.err_class).toBeNull();
			expect(row.err_code).toBeNull();
			expect(row.cache_status).toBeNull();
			expect(row.mode).toBeNull();
			expect(row.result_count).toBeNull();
			expect(row.query_len).toBeNull();
			expect(row.meta).toBeNull();
		} finally {
			sink.close();
		}
	});

	it("populates result and param fields when provided", () => {
		const sink = openSink(padded);
		try {
			writeEvent(sink, {
				ts: 1_700_000_000_001,
				tool: "suggest_files",
				dur_ms: 7,
				status: "ok",
				cache_status: "fresh",
				mode: "deep",
				result_count: 5,
				query_len: 12,
			});
			const row = sink.db
				.prepare("SELECT * FROM tool_calls")
				.get() as Record<string, unknown>;
			expect(row.cache_status).toBe("fresh");
			expect(row.mode).toBe("deep");
			expect(row.result_count).toBe(5);
			expect(row.query_len).toBe(12);
		} finally {
			sink.close();
		}
	});

	it("rejects unsafe err_class via sanitizer and stores null", () => {
		const sink = openSink(padded);
		try {
			writeEvent(sink, {
				ts: 1_700_000_000_002,
				tool: "suggest_files",
				dur_ms: 1,
				status: "error",
				err_class: "path /tmp/foo with spaces",
			});
			const row = sink.db
				.prepare("SELECT err_class FROM tool_calls")
				.get() as { err_class: unknown };
			expect(row.err_class).toBeNull();
		} finally {
			sink.close();
		}
	});
});

describe("openSink prune", () => {
	it("deletes rows older than 90 days on reopen", () => {
		const now = Date.now();
		const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;

		const sink1 = openSink(padded);
		writeEvent(sink1, {
			ts: now - ninetyOneDaysMs,
			tool: "old_tool",
			dur_ms: 1,
			status: "ok",
		});
		writeEvent(sink1, {
			ts: now,
			tool: "new_tool",
			dur_ms: 1,
			status: "ok",
		});
		sink1.close();

		const sink2 = openSink(padded);
		sink2.close();

		const ro = new Database(statsDbPath(padded), { readonly: true });
		try {
			const rows = ro
				.prepare("SELECT tool, ts FROM tool_calls ORDER BY ts")
				.all() as Array<{ tool: string; ts: number }>;
			expect(rows).toHaveLength(1);
			expect(rows[0].tool).toBe("new_tool");
		} finally {
			ro.close();
		}
	});
});
