import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { appendSurfaceEvent } from "../../../../src/lib/stats/surface-events.js";
import { loadSessionAdoption } from "../../../../src/lib/stats/sessions.js";

const KEY = "0123456789abcdef";
let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aicx-ses-"));
	process.env.AI_CORTEX_CACHE_HOME = home;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(home, { recursive: true, force: true });
});

function ev(o: Partial<Parameters<typeof writeEvent>[1]> & { tool: string }) {
	return { ts: Date.now(), dur_ms: 1, status: "ok" as const, ...o };
}

describe("loadSessionAdoption", () => {
	it("computes memoryUsed, recall→get, unattributed, surface→get", () => {
		const T = Date.now(); // within the 7d window (rows filtered by ts >= since)
		const s = openSink(KEY);
		writeEvent(s, ev({ tool: "recall_memory", session_id: "A", ts: T }));
		writeEvent(s, ev({ tool: "get_memory", session_id: "A", ts: T + 100 }));
		writeEvent(s, ev({ tool: "recall_memory", session_id: "B", ts: T }));
		writeEvent(s, ev({ tool: "record_memory", session_id: null, ts: T }));
		writeEvent(
			s,
			ev({ tool: "extract_session", session_id: "A", result_count: 4, ts: T }),
		);
		writeEvent(s, ev({ tool: "rewrite_memory", session_id: "A", ts: T }));
		writeEvent(s, ev({ tool: "deprecate_memory", session_id: "A", ts: T }));
		s.close();
		appendSurfaceEvent(KEY, {
			ts: T + 50,
			session_id: "A",
			memoryIds: ["m"],
			count: 1,
		});

		const { sessions, summary } = loadSessionAdoption(KEY, {
			windowMs: 7 * 24 * 3600 * 1000,
		});
		const byId = Object.fromEntries(sessions.map((r) => [r.sessionId, r]));
		expect(byId["A"]!.memoryUsed).toBe(true);
		expect(byId["B"]!.memoryUsed).toBe(false);
		expect(byId["(unattributed)"]!.memoryUsed).toBe(true); // record_memory
		expect(summary.recallToGetPct).toBe(50); // 1 of 2 recall-sessions
		expect(summary.surfaceToGetPct).toBe(100); // A surfacing then later get
		expect(summary.extractCleanupPct).toBe(50); // 2 cleanup / 4 candidates
		expect(summary.unattributedShare).toBeCloseTo(1 / 7, 2); // 1 of 7 events
		expect(summary.memoryUsedPct).toBeCloseTo((2 / 3) * 100, 1); // A + unattributed of 3
	});

	it("empty store → zeroed summary, no throw", () => {
		const { sessions, summary } = loadSessionAdoption(KEY, { windowMs: 1000 });
		expect(sessions).toEqual([]);
		expect(summary.memoryUsedPct).toBe(0);
	});

	it("corrupt stats DB → partial result (surface events still load, no throw)", () => {
		// Plant a file that better-sqlite3 cannot open (not a database).
		// On open: `new Database()` throws — the inviolable §9 contract is
		// that loadSessionAdoption must NOT propagate, leave rows=[], and
		// still aggregate from surface events.
		const dbPath = path.join(home, KEY, "stats", "events.sqlite");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		fs.writeFileSync(dbPath, "not a sqlite file");
		// One surface event so the aggregator has something to work with.
		appendSurfaceEvent(KEY, {
			ts: Date.now(),
			session_id: "S",
			memoryIds: ["m1"],
			count: 1,
		});

		expect(() =>
			loadSessionAdoption(KEY, { windowMs: 7 * 24 * 3600 * 1000 }),
		).not.toThrow();

		const { sessions, summary } = loadSessionAdoption(KEY, {
			windowMs: 7 * 24 * 3600 * 1000,
		});
		// Partial: SQL side empty (rows=[]) but surface side produced session S.
		const byId = Object.fromEntries(sessions.map((r) => [r.sessionId, r]));
		expect(byId["S"]!.surfacings).toBe(1);
		expect(byId["S"]!.memoryUsed).toBe(false); // no get/record in tool_calls
		// SQL totals are zero, so unattributedShare guards on totalEvents===0 → 0.
		expect(summary.unattributedShare).toBe(0);
		expect(summary.sessionCount).toBe(1);
	});
});
