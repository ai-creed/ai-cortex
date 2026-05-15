// src/lib/stats/query.ts
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { statsDbPath } from "./paths.js";
import { WINDOW_MS, type StatsWindow } from "./types.js";

function openRO(repoKey: string): DB | null {
	const p = statsDbPath(repoKey);
	if (!fs.existsSync(p)) return null;
	return new Database(p, { readonly: true });
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(
		sorted.length - 1,
		Math.floor((p / 100) * (sorted.length - 1)),
	);
	return sorted[idx];
}

export type Aggregate = {
	total: number;
	errs: number;
	p50: number;
	p95: number;
	cache_status: { fresh: number; reindexed: number; stale: number };
};

export function aggregate(repoKey: string, window: StatsWindow): Aggregate {
	const empty: Aggregate = {
		total: 0,
		errs: 0,
		p50: 0,
		p95: 0,
		cache_status: { fresh: 0, reindexed: 0, stale: 0 },
	};
	const db = openRO(repoKey);
	if (!db) return empty;
	try {
		const since = Date.now() - WINDOW_MS[window];
		const row = db
			.prepare(
				`SELECT count(*) AS n,
				        sum(status='error') AS errs,
				        sum(cache_status='fresh') AS fresh,
				        sum(cache_status='reindexed') AS reindexed,
				        sum(cache_status='stale') AS stale
				   FROM tool_calls WHERE ts > ?`,
			)
			.get(since) as {
			n: number | null;
			errs: number | null;
			fresh: number | null;
			reindexed: number | null;
			stale: number | null;
		};
		const durs = (
			db
				.prepare("SELECT dur_ms FROM tool_calls WHERE ts > ? ORDER BY dur_ms")
				.all(since) as Array<{ dur_ms: number }>
		).map((r) => r.dur_ms);
		return {
			total: row.n ?? 0,
			errs: row.errs ?? 0,
			p50: percentile(durs, 50),
			p95: percentile(durs, 95),
			cache_status: {
				fresh: row.fresh ?? 0,
				reindexed: row.reindexed ?? 0,
				stale: row.stale ?? 0,
			},
		};
	} finally {
		db.close();
	}
}
