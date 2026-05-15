// src/lib/stats/query.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { statsDbPath } from "./paths.js";
import { indexDbPath } from "../memory/paths.js";
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

export type ToolStat = { tool: string; n: number; errs: number };

export function topTools(
	repoKey: string,
	window: StatsWindow,
	limit: number,
): ToolStat[] {
	const db = openRO(repoKey);
	if (!db) return [];
	try {
		const since = Date.now() - WINDOW_MS[window];
		return db
			.prepare(
				`SELECT tool, count(*) AS n, sum(status='error') AS errs
				   FROM tool_calls WHERE ts > ?
				   GROUP BY tool
				   ORDER BY n DESC
				   LIMIT ?`,
			)
			.all(since, limit) as ToolStat[];
	} finally {
		db.close();
	}
}

export type LatencyStats = { p50: number; p95: number; samples: number };

export function latencyPerTool(
	repoKey: string,
	window: StatsWindow,
): Record<string, LatencyStats> {
	const db = openRO(repoKey);
	if (!db) return {};
	try {
		const since = Date.now() - WINDOW_MS[window];
		const tools = (
			db
				.prepare(`SELECT DISTINCT tool FROM tool_calls WHERE ts > ?`)
				.all(since) as Array<{ tool: string }>
		).map((r) => r.tool);
		const out: Record<string, LatencyStats> = {};
		for (const tool of tools) {
			const durs = (
				db
					.prepare(
						`SELECT dur_ms FROM tool_calls WHERE tool=? AND ts>? ORDER BY dur_ms`,
					)
					.all(tool, since) as Array<{ dur_ms: number }>
			).map((r) => r.dur_ms);
			out[tool] = {
				p50: percentile(durs, 50),
				p95: percentile(durs, 95),
				samples: durs.length,
			};
		}
		return out;
	} finally {
		db.close();
	}
}

export type TopMemory = {
	id: string;
	get_count: number;
	last_accessed_at: string | null;
};

export type MemoryHealth = {
	active: number;
	candidate: number;
	pinned: number;
	deprecated: number;
	topAccessed: TopMemory[];
};

export function memoryHealth(repoKey: string): MemoryHealth {
	const p = indexDbPath(repoKey);
	const empty: MemoryHealth = {
		active: 0,
		candidate: 0,
		pinned: 0,
		deprecated: 0,
		topAccessed: [],
	};
	if (!fs.existsSync(p)) return empty;
	const db = new Database(p, { readonly: true });
	try {
		const counts = db
			.prepare(
				`SELECT
				  sum(status='active') AS active,
				  sum(status='candidate') AS candidate,
				  sum(pinned=1) AS pinned,
				  sum(status='deprecated') AS deprecated
				FROM memories`,
			)
			.get() as {
			active: number | null;
			candidate: number | null;
			pinned: number | null;
			deprecated: number | null;
		};
		const top = db
			.prepare(
				`SELECT id, get_count, last_accessed_at
				   FROM memories WHERE status='active'
				   ORDER BY get_count DESC, id ASC LIMIT 5`,
			)
			.all() as TopMemory[];
		return {
			active: counts.active ?? 0,
			candidate: counts.candidate ?? 0,
			pinned: counts.pinned ?? 0,
			deprecated: counts.deprecated ?? 0,
			topAccessed: top,
		};
	} finally {
		db.close();
	}
}

const STORAGE_TTL_MS = 10_000;
let storageCache: { at: number; data: Record<string, number> } | null = null;

export function _resetStorageCacheForTest(): void {
	storageCache = null;
}

function cacheRoot(): string {
	return (
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1")
	);
}

function dirSize(dir: string): number {
	let total = 0;
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = path.join(cur, e.name);
			if (e.isDirectory()) stack.push(p);
			else {
				try {
					total += fs.statSync(p).size;
				} catch {
					/* race: file disappeared */
				}
			}
		}
	}
	return total;
}

export function storageFootprint(): Record<string, number> {
	const now = Date.now();
	if (storageCache && now - storageCache.at < STORAGE_TTL_MS) {
		return storageCache.data;
	}
	const root = cacheRoot();
	const out: Record<string, number> = {};
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// No cache root yet.
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		out[e.name] = dirSize(path.join(root, e.name));
	}
	storageCache = { at: now, data: out };
	return out;
}
