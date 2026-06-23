// src/lib/library/telemetry.ts
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { libraryRoot, telemetryDbPath } from "./paths.js";

export interface SearchEvent {
	ts: string; // ISO timestamp supplied by the caller
	sessionId?: string;
	turn?: number; // session turn at which the search fired; enables "later in session" ordering
	query: string;
	sourcesQueried: number;
	currentRepoKey?: string;
	hits: {
		sourceId: string;
		relPath: string;
		absPath: string;
		repoKey?: string;
	}[];
}

export interface O6Metrics {
	searches: number;
	returnedNonemptyRate: number;
	downstreamTouchRate: number;
	inRepoHitRatio: number;
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  turn INTEGER,
  query TEXT NOT NULL,
  sources_queried INTEGER NOT NULL,
  hit_count INTEGER NOT NULL,
  current_repo_key TEXT
);
CREATE TABLE IF NOT EXISTS search_hits (
  search_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  abs_path TEXT NOT NULL,
  repo_key TEXT,
  same_repo INTEGER NOT NULL
);
`;

function open(): DB {
	fs.mkdirSync(libraryRoot(), { recursive: true });
	const db = new Database(telemetryDbPath());
	db.exec(SCHEMA_SQL);
	return db;
}

export function recordSearch(event: SearchEvent): void {
	const db = open();
	try {
		const tx = db.transaction(() => {
			const info = db
				.prepare(
					`INSERT INTO searches (ts, session_id, turn, query, sources_queried, hit_count, current_repo_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					event.ts,
					event.sessionId ?? null,
					event.turn ?? null,
					event.query,
					event.sourcesQueried,
					event.hits.length,
					event.currentRepoKey ?? null,
				);
			const insHit = db.prepare(
				`INSERT INTO search_hits (search_id, source_id, rel_path, abs_path, repo_key, same_repo)
         VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const h of event.hits) {
				const sameRepo =
					event.currentRepoKey !== undefined &&
					h.repoKey === event.currentRepoKey
						? 1
						: 0;
				insHit.run(
					info.lastInsertRowid,
					h.sourceId,
					h.relPath,
					h.absPath,
					h.repoKey ?? null,
					sameRepo,
				);
			}
		});
		tx();
	} finally {
		db.close();
	}
}

// Pure: did any returned doc appear among the session file paths that occurred
// AFTER the search? The caller passes only later-than-search touches; this keeps
// the "later in the same session" rule out of the set-overlap check.
export function downstreamTouch(
	returnedAbsPaths: string[],
	laterTouchPaths: string[],
): boolean {
	if (returnedAbsPaths.length === 0) return false;
	const touched = new Set(laterTouchPaths.map((p) => path.resolve(p)));
	return returnedAbsPaths.some((p) => touched.has(path.resolve(p)));
}

export async function computeO6Metrics(opts: {
	sessionFilePaths: (
		sessionId: string,
		repoKey: string | undefined,
	) => Promise<{ path: string; turn: number }[]>;
}): Promise<O6Metrics> {
	const db = open();
	try {
		const searches = db
			.prepare(
				"SELECT id, session_id AS sessionId, turn, current_repo_key AS repoKey, hit_count AS hitCount FROM searches",
			)
			.all() as {
			id: number;
			sessionId: string | null;
			turn: number | null;
			repoKey: string | null;
			hitCount: number;
		}[];
		const total = searches.length;
		if (total === 0) {
			return {
				searches: 0,
				returnedNonemptyRate: 0,
				downstreamTouchRate: 0,
				inRepoHitRatio: 0,
			};
		}
		const nonempty = searches.filter((s) => s.hitCount > 0).length;

		let touched = 0;
		const hitStmt = db.prepare(
			"SELECT abs_path AS absPath FROM search_hits WHERE search_id = ?",
		);
		for (const s of searches) {
			// Need the search turn to enforce "later in the same session"; skip if unknown.
			if (s.hitCount === 0 || !s.sessionId || s.turn === null) continue;
			const absPaths = (hitStmt.all(s.id) as { absPath: string }[]).map(
				(r) => r.absPath,
			);
			const touches = await opts.sessionFilePaths(
				s.sessionId,
				s.repoKey ?? undefined,
			);
			const laterTouches = touches
				.filter((t) => t.turn > s.turn!)
				.map((t) => t.path);
			if (downstreamTouch(absPaths, laterTouches)) touched++;
		}

		const hitTotals = db
			.prepare(
				"SELECT COUNT(*) AS n, COALESCE(SUM(same_repo),0) AS inrepo FROM search_hits",
			)
			.get() as { n: number; inrepo: number };

		return {
			searches: total,
			returnedNonemptyRate: nonempty / total,
			downstreamTouchRate: touched / total,
			inRepoHitRatio: hitTotals.n > 0 ? hitTotals.inrepo / hitTotals.n : 0,
		};
	} finally {
		db.close();
	}
}
