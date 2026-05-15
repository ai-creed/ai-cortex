// src/lib/stats/sink.ts
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";
import { statsDir, statsDbPath } from "./paths.js";
import { safeTag } from "./sanitize.js";
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
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tc_ts      ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_tc_tool_ts ON tool_calls(tool, ts);
`;
const SCHEMA_VERSION = 1;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type StatsSink = { db: DB; insert: Statement; close: () => void };

export function openSink(repoKey: string): StatsSink {
	fs.mkdirSync(statsDir(repoKey), { recursive: true });
	const db = new Database(statsDbPath(repoKey));
	db.exec(SCHEMA_SQL);
	const v = db.pragma("user_version", { simple: true }) as number;
	if (v !== SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
	db.prepare("DELETE FROM tool_calls WHERE ts < ?").run(
		Date.now() - RETENTION_MS,
	);
	const insert = db.prepare(`
    INSERT INTO tool_calls
    (ts, tool, dur_ms, status, err_class, err_code, cache_status, mode, result_count, query_len, meta)
    VALUES (@ts, @tool, @dur_ms, @status, @err_class, @err_code, @cache_status, @mode, @result_count, @query_len, @meta)
  `);
	return { db, insert, close: () => db.close() };
}

export function writeEvent(sink: StatsSink, ev: StatsEvent): void {
	try {
		sink.insert.run({
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
			meta: null,
		});
	} catch (err) {
		process.stderr.write(
			`[ai-cortex] stats sink write failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}
