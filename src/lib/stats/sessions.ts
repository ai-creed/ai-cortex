// src/lib/stats/sessions.ts
import Database from "better-sqlite3";
import fs from "node:fs";
import { statsDbPath } from "./paths.js";
import { readSurfaceEvents } from "./surface-events.js";

const UNATTRIBUTED = "(unattributed)";
const CLEANUP = new Set([
	"rewrite_memory",
	"deprecate_memory",
	"confirm_memory",
]);

export type SessionRow = {
	sessionId: string;
	firstTs: number;
	lastTs: number;
	totalCalls: number;
	recall: number;
	get: number;
	record: number;
	surfacings: number;
	memoryUsed: boolean;
};

export type AdoptionSummary = {
	sessionCount: number;
	memoryUsedPct: number;
	recallToGetPct: number;
	surfaceToGetPct: number;
	extractCleanupPct: number;
	unattributedShare: number;
	histogram: { used: number; notUsed: number };
};

/** Zeroed adoption bundle — overview placeholder + test fixtures (single source). */
export const EMPTY_ADOPTION: { sessions: SessionRow[]; summary: AdoptionSummary } = {
	sessions: [],
	summary: {
		sessionCount: 0,
		memoryUsedPct: 0,
		recallToGetPct: 0,
		surfaceToGetPct: 0,
		extractCleanupPct: 0,
		unattributedShare: 0,
		histogram: { used: 0, notUsed: 0 },
	},
};

type Row = {
	tool: string;
	ts: number;
	result_count: number | null;
	session_id: string | null;
};

function pushToGroup<V>(map: Map<string, V[]>, key: string, value: V): void {
	const arr = map.get(key);
	if (arr) arr.push(value);
	else map.set(key, [value]);
}

export function loadSessionAdoption(
	repoKey: string,
	opts: { windowMs: number },
): { sessions: SessionRow[]; summary: AdoptionSummary } {
	const since = Date.now() - opts.windowMs;
	let rows: Row[] = [];
	if (fs.existsSync(statsDbPath(repoKey))) {
		const db = new Database(statsDbPath(repoKey), { readonly: true });
		try {
			// Task 1's fallback intentionally preserves a degraded DB with NO
			// session_id column. The reader must NOT assume it exists, or the
			// SELECT throws on exactly that shape — column-detect and project
			// NULL when absent.
			const hasSession = (
				db.prepare("PRAGMA table_info(tool_calls)").all() as Array<{
					name: string;
				}>
			).some((c) => c.name === "session_id");
			rows = db
				.prepare(
					`SELECT tool, ts, result_count, ${
						hasSession ? "session_id" : "NULL AS session_id"
					} FROM tool_calls WHERE ts >= ?`,
				)
				.all(since) as Row[];
		} finally {
			db.close();
		}
	}
	const surface = readSurfaceEvents(repoKey).filter((e) => e.ts >= since);

	const g = new Map<string, Row[]>();
	for (const r of rows) {
		const k = r.session_id ?? UNATTRIBUTED;
		pushToGroup(g, k, r);
	}
	const surfBySession = new Map<string, { ts: number }[]>();
	for (const e of surface) {
		const k = e.session_id ?? UNATTRIBUTED;
		pushToGroup(surfBySession, k, { ts: e.ts });
	}
	for (const k of surfBySession.keys()) if (!g.has(k)) g.set(k, []);

	const sessions: SessionRow[] = [];
	let recallSessions = 0;
	let recallToGet = 0;
	let surfSessions = 0;
	let surfToGet = 0;
	for (const [sid, rs] of g) {
		const tsList = rs.map((r) => r.ts);
		const surf = surfBySession.get(sid) ?? [];
		for (const x of surf) tsList.push(x.ts);
		const count = (t: string) => rs.filter((r) => r.tool === t).length;
		const recall = count("recall_memory");
		const get = count("get_memory");
		const record = count("record_memory");
		const memoryUsed = get >= 1 || record >= 1;
		sessions.push({
			sessionId: sid,
			firstTs: tsList.length ? Math.min(...tsList) : 0,
			lastTs: tsList.length ? Math.max(...tsList) : 0,
			totalCalls: rs.length,
			recall,
			get,
			record,
			surfacings: surf.length,
			memoryUsed,
		});
		if (recall >= 1) {
			recallSessions++;
			const firstRecall = Math.min(
				...rs.filter((r) => r.tool === "recall_memory").map((r) => r.ts),
			);
			if (rs.some((r) => r.tool === "get_memory" && r.ts > firstRecall))
				recallToGet++;
		}
		if (surf.length >= 1) {
			surfSessions++;
			const firstSurf = Math.min(...surf.map((x) => x.ts));
			if (rs.some((r) => r.tool === "get_memory" && r.ts > firstSurf))
				surfToGet++;
		}
	}

	const totalEvents = rows.length;
	const unattributed = rows.filter((r) => r.session_id == null).length;
	const candidates = rows
		.filter((r) => r.tool === "extract_session")
		.reduce((a, r) => a + (r.result_count ?? 0), 0);
	const cleanup = rows.filter((r) => CLEANUP.has(r.tool)).length;
	const used = sessions.filter((s) => s.memoryUsed).length;

	const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);
	const summary: AdoptionSummary = {
		sessionCount: sessions.length,
		memoryUsedPct: pct(used, sessions.length),
		recallToGetPct: pct(recallToGet, recallSessions),
		surfaceToGetPct: pct(surfToGet, surfSessions),
		extractCleanupPct: pct(cleanup, candidates),
		unattributedShare: totalEvents === 0 ? 0 : unattributed / totalEvents,
		histogram: { used, notUsed: sessions.length - used },
	};
	return {
		sessions: sessions.sort((a, b) => b.lastTs - a.lastTs),
		summary,
	};
}
