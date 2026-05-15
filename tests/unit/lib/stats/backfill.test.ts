import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
	backfillRepo,
	backfillAll,
} from "../../../../src/lib/stats/backfill.js";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { statsDbPath } from "../../../../src/lib/stats/paths.js";
import { sessionJsonPath } from "../../../../src/lib/history/store.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

const repoKey = "6261636b66696c61"; // "backfila" + pad

let tmp: string;
let originalCacheHome: string | undefined;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stats-backfill-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(() => {
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSession(
	rk: string,
	sessionId: string,
	overrides: Partial<SessionRecord> = {},
): void {
	const sjson = sessionJsonPath(rk, sessionId);
	fs.mkdirSync(path.dirname(sjson), { recursive: true });
	const record: SessionRecord = {
		version: 2,
		id: sessionId,
		startedAt: "2026-05-14T10:00:00.000Z",
		endedAt: null,
		turnCount: 0,
		lastProcessedTurn: 0,
		hasSummary: false,
		hasRaw: false,
		rawDroppedAt: null,
		transcriptPath: "",
		summary: "",
		evidence: {
			toolCalls: [],
			filePaths: [],
			userPrompts: [],
			corrections: [],
		},
		chunks: [],
		...overrides,
	};
	fs.writeFileSync(sjson, JSON.stringify(record), "utf8");
}

describe("backfillRepo", () => {
	it("inserts one synthetic row per ai-cortex tool call and skips non-cortex", () => {
		writeSession(repoKey, "sess-1", {
			startedAt: "2026-05-14T10:00:00.000Z",
			evidence: {
				toolCalls: [
					{ turn: 1, name: "recall_memory", args: "auth flow" },
					{ turn: 2, name: "Read", args: "/some/file" },
					{ turn: 3, name: "suggest_files", args: "login" },
					{ turn: 4, name: "Bash", args: "ls -la" },
					{ turn: 5, name: "get_memory", args: "mem-123" },
				],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
		});

		const result = backfillRepo(repoKey);
		expect(result.sessionsScanned).toBe(1);
		expect(result.rowsInserted).toBe(3);
		expect(result.skipped.nonCortex).toBe(2);
		expect(result.skipped.missingSession).toBe(0);

		const ro = new Database(statsDbPath(repoKey), { readonly: true });
		try {
			const rows = ro
				.prepare(
					"SELECT tool, dur_ms, status, synthetic, query_len FROM tool_calls ORDER BY tool",
				)
				.all() as Array<{
				tool: string;
				dur_ms: number;
				status: string;
				synthetic: number;
				query_len: number | null;
			}>;
			expect(rows).toHaveLength(3);
			expect(rows.map((r) => r.tool)).toEqual([
				"get_memory",
				"recall_memory",
				"suggest_files",
			]);
			for (const r of rows) {
				expect(r.dur_ms).toBe(0);
				expect(r.status).toBe("ok");
				expect(r.synthetic).toBe(1);
				expect(r.query_len).toBeGreaterThan(0);
			}
		} finally {
			ro.close();
		}
	});

	it("uses session.startedAt as ts for all rows", () => {
		writeSession(repoKey, "sess-ts", {
			startedAt: "2026-05-14T12:34:56.000Z",
			evidence: {
				toolCalls: [
					{ turn: 1, name: "recall_memory", args: "x" },
					{ turn: 2, name: "get_memory", args: "y" },
				],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
		});
		backfillRepo(repoKey);
		const ro = new Database(statsDbPath(repoKey), { readonly: true });
		try {
			const rows = ro
				.prepare("SELECT ts FROM tool_calls")
				.all() as Array<{ ts: number }>;
			const expected = Date.parse("2026-05-14T12:34:56.000Z");
			for (const r of rows) expect(r.ts).toBe(expected);
		} finally {
			ro.close();
		}
	});

	it("is idempotent — re-running replaces synthetic rows", () => {
		writeSession(repoKey, "sess-idem", {
			evidence: {
				toolCalls: [
					{ turn: 1, name: "recall_memory", args: "a" },
					{ turn: 2, name: "get_memory", args: "b" },
				],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
		});
		const r1 = backfillRepo(repoKey);
		const r2 = backfillRepo(repoKey);
		expect(r1.rowsInserted).toBe(2);
		expect(r2.rowsInserted).toBe(2);
		const ro = new Database(statsDbPath(repoKey), { readonly: true });
		try {
			const n = (
				ro.prepare("SELECT count(*) AS n FROM tool_calls").get() as {
					n: number;
				}
			).n;
			expect(n).toBe(2);
		} finally {
			ro.close();
		}
	});

	it("preserves pre-existing real (synthetic=0) rows across backfill runs", () => {
		// Seed one real row first.
		const sink = openSink(repoKey);
		writeEvent(sink, {
			ts: Date.now(),
			tool: "recall_memory",
			dur_ms: 17,
			status: "ok",
		});
		// Also a stray synthetic row that backfill should replace.
		writeEvent(sink, {
			ts: Date.now(),
			tool: "old_synth",
			dur_ms: 0,
			status: "ok",
			synthetic: 1,
		});
		sink.close();

		writeSession(repoKey, "sess-mix", {
			evidence: {
				toolCalls: [{ turn: 1, name: "suggest_files", args: "q" }],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
		});
		const result = backfillRepo(repoKey);
		expect(result.rowsInserted).toBe(1);

		const ro = new Database(statsDbPath(repoKey), { readonly: true });
		try {
			const rows = ro
				.prepare("SELECT tool, synthetic, dur_ms FROM tool_calls ORDER BY tool")
				.all() as Array<{ tool: string; synthetic: number; dur_ms: number }>;
			// Real row preserved, old synthetic row deleted, new synthetic inserted.
			expect(rows).toEqual([
				{ tool: "recall_memory", synthetic: 0, dur_ms: 17 },
				{ tool: "suggest_files", synthetic: 1, dur_ms: 0 },
			]);
		} finally {
			ro.close();
		}
	});

	it("counts malformed JSON as missingSession", () => {
		const sjson = sessionJsonPath(repoKey, "broken");
		fs.mkdirSync(path.dirname(sjson), { recursive: true });
		fs.writeFileSync(sjson, "{not-json", "utf8");

		const result = backfillRepo(repoKey);
		expect(result.sessionsScanned).toBe(0);
		expect(result.skipped.missingSession).toBe(1);
		expect(result.rowsInserted).toBe(0);
	});

	it("returns an empty result for a repo with no history dir", () => {
		// Create the cache repo dir but not history/sessions.
		fs.mkdirSync(path.join(tmp, repoKey), { recursive: true });
		const result = backfillRepo(repoKey);
		expect(result.sessionsScanned).toBe(0);
		expect(result.rowsInserted).toBe(0);
		expect(result.skipped.missingSession).toBe(0);
		expect(result.skipped.nonCortex).toBe(0);
	});
});

describe("backfillAll", () => {
	it("processes every repoKey-shaped subdir of the cache root", () => {
		const rkA = "61".repeat(8);
		const rkB = "62".repeat(8);
		writeSession(rkA, "sa", {
			evidence: {
				toolCalls: [{ turn: 1, name: "recall_memory", args: "a" }],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
		});
		writeSession(rkB, "sb", {
			evidence: {
				toolCalls: [
					{ turn: 1, name: "get_memory", args: "b" },
					{ turn: 2, name: "Read", args: "/x" },
				],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
		});
		const results = backfillAll();
		const byRepo = Object.fromEntries(results.map((r) => [r.repoKey, r]));
		expect(byRepo[rkA].rowsInserted).toBe(1);
		expect(byRepo[rkB].rowsInserted).toBe(1);
		expect(byRepo[rkB].skipped.nonCortex).toBe(1);
	});
});
