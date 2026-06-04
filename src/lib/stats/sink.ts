// src/lib/stats/sink.ts
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";
import { statsDir, statsDbPath } from "./paths.js";
import { safeTag, safeMessage } from "./sanitize.js";
import type { StatsEvent } from "./types.js";

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS tool_calls (
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
  meta          TEXT,
  synthetic     INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tc_ts      ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_tc_tool_ts ON tool_calls(tool, ts);
`;
const SCHEMA_VERSION = 3;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type StatsSink = {
	db: DB;
	insert: Statement;
	hasSessionId: boolean;
	close: () => void;
};

function migrate(db: DB): void {
	let v = db.pragma("user_version", { simple: true }) as number;
	const cols = () =>
		(
			db.prepare("PRAGMA table_info(tool_calls)").all() as Array<{
				name: string;
			}>
		).map((c) => c.name);
	if (v === 1) {
		if (!cols().includes("synthetic")) {
			db.exec(
				"ALTER TABLE tool_calls ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0",
			);
		}
		db.pragma("user_version = 2");
		v = 2;
	}
	if (v === 2) {
		if (!cols().includes("session_id")) {
			db.exec("ALTER TABLE tool_calls ADD COLUMN session_id TEXT");
		}
		db.pragma("user_version = 3");
		v = 3;
	}
	// Backstop: a user_version ahead of this code (downgrade) settles to the current version; column-detect keeps inserts safe regardless.
	if (v !== SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

const INSERT_V3 = `
    INSERT INTO tool_calls
    (ts, tool, dur_ms, status, err_class, err_code, cache_status, mode, result_count, query_len, meta, synthetic, session_id)
    VALUES (@ts, @tool, @dur_ms, @status, @err_class, @err_code, @cache_status, @mode, @result_count, @query_len, @meta, @synthetic, @session_id)
  `;
const INSERT_LEGACY = `
    INSERT INTO tool_calls
    (ts, tool, dur_ms, status, err_class, err_code, cache_status, mode, result_count, query_len, meta, synthetic)
    VALUES (@ts, @tool, @dur_ms, @status, @err_class, @err_code, @cache_status, @mode, @result_count, @query_len, @meta, @synthetic)
  `;

export function openSink(repoKey: string): StatsSink {
	fs.mkdirSync(statsDir(repoKey), { recursive: true });
	const db = new Database(statsDbPath(repoKey));
	db.exec(SCHEMA_SQL);
	// A thrown migration (locked DB, blocked ALTER, etc.) must NOT break the
	// sink — column-detect below is authoritative either way.
	try {
		migrate(db);
	} catch (err) {
		process.stderr.write(
			`[ai-cortex] stats migrate failed (continuing with detected columns): ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
	db.prepare("DELETE FROM tool_calls WHERE ts < ?").run(
		Date.now() - RETENTION_MS,
	);
	const hasSessionId = (
		db.prepare("PRAGMA table_info(tool_calls)").all() as Array<{
			name: string;
		}>
	).some((c) => c.name === "session_id");
	const insert = db.prepare(hasSessionId ? INSERT_V3 : INSERT_LEGACY);
	return { db, insert, hasSessionId, close: () => db.close() };
}

export function writeEvent(sink: StatsSink, ev: StatsEvent): void {
	try {
		const base = {
			ts: ev.ts,
			tool: ev.tool,
			dur_ms: ev.dur_ms,
			status: ev.status,
			err_class: safeTag(ev.err_class) ?? null,
			err_code: safeTag(ev.err_code) ?? null,
			cache_status: ev.cache_status ?? null,
			mode: ev.mode ?? null,
			result_count: ev.result_count ?? null,
			query_len: ev.query_len ?? null,
			// `meta` carries the sanitized error message (the "why") for failures.
			meta: safeMessage(ev.err_message),
			synthetic: ev.synthetic ?? 0,
		};
		sink.insert.run(
			sink.hasSessionId ? { ...base, session_id: ev.session_id ?? null } : base,
		);
	} catch (err) {
		process.stderr.write(
			`[ai-cortex] stats sink write failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}
