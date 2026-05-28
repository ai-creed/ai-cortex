import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { suggestHitRate } from "../../../../src/lib/stats/query.js";
import { statsDbPath, statsDir } from "../../../../src/lib/stats/paths.js";

const REPO = "ddddddddddddddd1";

function seed(rows: Array<{ tool: string; result_count: number | null; tsOffsetMs: number }>): void {
	fs.mkdirSync(statsDir(REPO), { recursive: true });
	const db = new Database(statsDbPath(REPO));
	db.exec(`CREATE TABLE tool_calls (
		ts INTEGER NOT NULL, tool TEXT NOT NULL, dur_ms INTEGER NOT NULL,
		status TEXT NOT NULL, err_class TEXT, err_code TEXT, cache_status TEXT,
		mode TEXT, result_count INTEGER, query_len INTEGER, meta TEXT,
		synthetic INTEGER NOT NULL DEFAULT 0, session_id TEXT
	)`);
	const ins = db.prepare(
		"INSERT INTO tool_calls (ts,tool,dur_ms,status,result_count) VALUES (?,?,?,?,?)",
	);
	const now = Date.now();
	for (const r of rows) ins.run(now - r.tsOffsetMs, r.tool, 1, "ok", r.result_count);
	db.close();
}

describe("suggestHitRate", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-sugg-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("returns 0 when no suggest_files calls in window", () => {
		seed([{ tool: "recall_memory", result_count: 3, tsOffsetMs: 1000 }]);
		expect(suggestHitRate(REPO, "7d")).toBe(0);
	});

	it("returns hits / non-null total over the window (nulls excluded per spec)", () => {
		seed([
			{ tool: "suggest_files", result_count: 5, tsOffsetMs: 1000 },
			{ tool: "suggest_files", result_count: 0, tsOffsetMs: 2000 },
			{ tool: "suggest_files", result_count: 12, tsOffsetMs: 3000 },
			{ tool: "suggest_files", result_count: null, tsOffsetMs: 4000 },
		]);
		expect(suggestHitRate(REPO, "7d")).toBeCloseTo(2 / 3, 5);
	});

	it("returns 0 when every suggest_files row has null result_count", () => {
		seed([
			{ tool: "suggest_files", result_count: null, tsOffsetMs: 1000 },
			{ tool: "suggest_files", result_count: null, tsOffsetMs: 2000 },
		]);
		expect(suggestHitRate(REPO, "7d")).toBe(0);
	});

	it("ignores non-suggest_files rows", () => {
		seed([
			{ tool: "suggest_files", result_count: 1, tsOffsetMs: 1000 },
			{ tool: "recall_memory", result_count: 0, tsOffsetMs: 1000 },
		]);
		expect(suggestHitRate(REPO, "7d")).toBe(1);
	});
});
