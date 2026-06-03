// src/lib/stats/query.ts
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { cacheRoot, statsDbPath } from "./paths.js";
import { readExcluded } from "./hygiene.js";
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
				.prepare(
					"SELECT dur_ms FROM tool_calls WHERE ts > ? AND synthetic = 0 ORDER BY dur_ms",
				)
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

export function suggestHitCounts(
	repoKey: string,
	window: StatsWindow,
): { hits: number; total: number } {
	const db = openRO(repoKey);
	if (!db) return { hits: 0, total: 0 };
	try {
		const since = Date.now() - WINDOW_MS[window];
		// Spec §testing: nulls excluded — `result_count IS NOT NULL` keeps
		// rows without a recorded outcome from poisoning the denominator.
		const row = db
			.prepare(
				`SELECT
					count(*) AS total,
					sum(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) AS hits
				   FROM tool_calls
				  WHERE tool = 'suggest_files'
				    AND ts > ?
				    AND result_count IS NOT NULL`,
			)
			.get(since) as { total: number | null; hits: number | null };
		return { hits: row.hits ?? 0, total: row.total ?? 0 };
	} finally {
		db.close();
	}
}

export function suggestHitRate(repoKey: string, window: StatsWindow): number {
	const { hits, total } = suggestHitCounts(repoKey, window);
	return total === 0 ? 0 : hits / total;
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
				.prepare("SELECT DISTINCT tool FROM tool_calls WHERE ts > ?")
				.all(since) as Array<{ tool: string }>
		).map((r) => r.tool);
		const out: Record<string, LatencyStats> = {};
		for (const tool of tools) {
			const durs = (
				db
					.prepare(
						"SELECT dur_ms FROM tool_calls WHERE tool=? AND ts>? AND synthetic = 0 ORDER BY dur_ms",
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

export type CacheMeta = {
	indexedAt: string | null;
	fingerprint: string | null;
	fileCount: number | null;
	name: string | null;
	/** Origin worktree absolute path; used by the clean-confirm dialog
	 * (spec line 243: "Origin path comes from cacheMeta when available;
	 * otherwise omitted"). */
	worktreePath: string | null;
};

const EMPTY_CACHE_META: CacheMeta = {
	indexedAt: null,
	fingerprint: null,
	fileCount: null,
	name: null,
	worktreePath: null,
};

const SIDECAR_SUFFIX = ".meta.json";

function readSidecarSync(sidecarPath: string): CacheMeta | null {
	let raw: string;
	try {
		raw = fs.readFileSync(sidecarPath, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<CacheMeta>;
		if (parsed === null || typeof parsed !== "object") return null;
		return {
			indexedAt: typeof parsed.indexedAt === "string" ? parsed.indexedAt : null,
			fingerprint:
				typeof parsed.fingerprint === "string" ? parsed.fingerprint : null,
			fileCount:
				typeof parsed.fileCount === "number" ? parsed.fileCount : null,
			name: typeof parsed.name === "string" ? parsed.name : null,
			worktreePath:
				typeof parsed.worktreePath === "string" ? parsed.worktreePath : null,
		};
	} catch {
		return null;
	}
}

function writeSidecarSync(sidecarPath: string, meta: CacheMeta): void {
	const tmp = sidecarPath + ".tmp";
	try {
		fs.writeFileSync(tmp, JSON.stringify(meta) + "\n");
		fs.renameSync(tmp, sidecarPath);
	} catch {
		// Best-effort self-heal. Clean up tmp if rename failed.
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* tmp may not exist */
		}
	}
}

function readFromMainJson(jsonPath: string): CacheMeta | null {
	let raw: string;
	try {
		raw = fs.readFileSync(jsonPath, "utf8");
	} catch {
		return null;
	}
	try {
		const data = JSON.parse(raw) as {
			indexedAt?: string;
			fingerprint?: string;
			files?: unknown[];
			packageMeta?: { name?: string };
			worktreePath?: string;
		};
		return {
			indexedAt: data.indexedAt ?? null,
			fingerprint: data.fingerprint ?? null,
			fileCount: Array.isArray(data.files) ? data.files.length : null,
			name: data.packageMeta?.name ?? null,
			worktreePath: typeof data.worktreePath === "string" ? data.worktreePath : null,
		};
	} catch {
		return null;
	}
}

export function cacheMeta(repoKey: string): CacheMeta {
	const dir = path.join(cacheRoot(), repoKey);
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { ...EMPTY_CACHE_META };
	}

	// Discover worktree keys independent of the structural format: from sidecars
	// (.meta.json), the SQLite store (.db), and legacy manifests (.json). The
	// structural store is now a .db, so enumerating only .json would miss every
	// migrated worktree (its .json is deleted) even though its sidecar exists.
	const keys = new Set<string>();
	for (const e of entries) {
		if (!e.isFile()) continue;
		if (e.name.endsWith(SIDECAR_SUFFIX)) {
			keys.add(e.name.slice(0, -SIDECAR_SUFFIX.length));
		} else if (e.name.endsWith(".db")) {
			keys.add(e.name.slice(0, -".db".length));
		} else if (e.name.endsWith(".json")) {
			keys.add(e.name.slice(0, -".json".length));
		}
	}

	let best: CacheMeta = { ...EMPTY_CACHE_META };
	for (const key of keys) {
		const sidecarPath = path.join(dir, key + SIDECAR_SUFFIX);
		const jsonPath = path.join(dir, key + ".json");

		let meta = readSidecarSync(sidecarPath);
		if (!meta && fs.existsSync(jsonPath)) {
			// Legacy manifest with no sidecar: read and self-heal the sidecar.
			meta = readFromMainJson(jsonPath);
			if (meta) writeSidecarSync(sidecarPath, meta);
		}
		if (!meta) continue;

		if (
			!best.indexedAt ||
			(meta.indexedAt && meta.indexedAt > best.indexedAt)
		) {
			best = meta;
		}
	}
	return best;
}

const REPO_KEY_RE = /^[0-9a-f]{16}$/;

// Bootstrap-friendly: any cache subdir with a hashed repoKey name counts as a
// project. We don't require a stats/ subdir — that gets created lazily on the
// first MCP call after this branch lands, so older repos with cache JSON or
// memory data but no recent activity still show up (with zero calls in the
// window until they tick).
export function listProjects(): string[] {
	const root = cacheRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const excluded = new Set(readExcluded());
	return entries
		.filter((e) => e.isDirectory() && REPO_KEY_RE.test(e.name))
		.map((e) => e.name)
		.filter((n) => !excluded.has(n))
		.sort();
}

export function aggregateAcross(
	repoKeys: string[],
	window: StatsWindow,
): Aggregate {
	const empty: Aggregate = {
		total: 0,
		errs: 0,
		p50: 0,
		p95: 0,
		cache_status: { fresh: 0, reindexed: 0, stale: 0 },
	};
	if (repoKeys.length === 0) return empty;
	const since = Date.now() - WINDOW_MS[window];
	let total = 0;
	let errs = 0;
	const cache = { fresh: 0, reindexed: 0, stale: 0 };
	const durs: number[] = [];
	for (const rk of repoKeys) {
		const db = openRO(rk);
		if (!db) continue;
		try {
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
			total += row.n ?? 0;
			errs += row.errs ?? 0;
			cache.fresh += row.fresh ?? 0;
			cache.reindexed += row.reindexed ?? 0;
			cache.stale += row.stale ?? 0;
			for (const r of db
				.prepare(
					"SELECT dur_ms FROM tool_calls WHERE ts > ? AND synthetic = 0",
				)
				.iterate(since)) {
				durs.push((r as { dur_ms: number }).dur_ms);
			}
		} finally {
			db.close();
		}
	}
	durs.sort((a, b) => a - b);
	return {
		total,
		errs,
		p50: percentile(durs, 50),
		p95: percentile(durs, 95),
		cache_status: cache,
	};
}

export function memoryHealthAcross(repoKeys: string[]): MemoryHealth {
	const merged: MemoryHealth = {
		active: 0,
		candidate: 0,
		pinned: 0,
		deprecated: 0,
		topAccessed: [],
	};
	for (const rk of repoKeys) {
		const m = memoryHealth(rk);
		merged.active += m.active;
		merged.candidate += m.candidate;
		merged.pinned += m.pinned;
		merged.deprecated += m.deprecated;
		merged.topAccessed.push(...m.topAccessed);
	}
	merged.topAccessed.sort((a, b) => b.get_count - a.get_count);
	merged.topAccessed = merged.topAccessed.slice(0, 5);
	return merged;
}

export function toolCounts(
	repoKeys: string[],
	window: StatsWindow,
): Record<string, number> {
	const out: Record<string, number> = {};
	const since = Date.now() - WINDOW_MS[window];
	for (const rk of repoKeys) {
		const db = openRO(rk);
		if (!db) continue;
		try {
			for (const row of db
				.prepare(
					"SELECT tool, count(*) AS n FROM tool_calls WHERE ts > ? GROUP BY tool",
				)
				.all(since) as Array<{ tool: string; n: number }>) {
				out[row.tool] = (out[row.tool] ?? 0) + row.n;
			}
		} finally {
			db.close();
		}
	}
	return out;
}

export type MemoryActivity = {
	recorded: number[];
	used: number[];
	recordedTotal: number;
	usedTotal: number;
	buckets: number;
};

const ACTIVITY_BUCKETS = 30;

export function memoryActivity(
	repoKey: string,
	window: StatsWindow,
): MemoryActivity {
	const span = WINDOW_MS[window];
	const nowMs = Date.now();
	const sinceMs = nowMs - span;
	const bucketMs = span / ACTIVITY_BUCKETS;
	const recorded = new Array<number>(ACTIVITY_BUCKETS).fill(0);
	const used = new Array<number>(ACTIVITY_BUCKETS).fill(0);

	// Reject out-of-range timestamps entirely (no clamping): a future-dated
	// row from clock skew or odd backfill must NOT be counted in the last
	// bucket. The SQL queries also bound by nowMs as a first line of defense.
	const bucketOf = (tsMs: number): number => {
		const i = Math.floor((tsMs - sinceMs) / bucketMs);
		return i < 0 || i >= ACTIVITY_BUCKETS ? -1 : i;
	};

	// recorded — memory_audit (ts is ISO TEXT). indexDbPath() throws on a
	// non-hashed repoKey; guard it so the series is just all-zero.
	let idxPath: string | null = null;
	try {
		idxPath = indexDbPath(repoKey);
	} catch {
		idxPath = null;
	}
	if (idxPath && fs.existsSync(idxPath)) {
		let db: Database.Database | null = null;
		try {
			db = new Database(idxPath, { readonly: true });
			const sinceIso = new Date(sinceMs).toISOString();
			const nowIso = new Date(nowMs).toISOString();
			const rows = db
				.prepare(
					"SELECT ts FROM memory_audit WHERE change_type='create' AND ts >= ? AND ts < ?",
				)
				.all(sinceIso, nowIso) as Array<{ ts: string }>;
			for (const r of rows) {
				const ms = Date.parse(r.ts);
				if (Number.isNaN(ms)) continue;
				const b = bucketOf(ms);
				if (b >= 0) recorded[b]++;
			}
		} catch {
			/* leave recorded all-zero */
		} finally {
			db?.close();
		}
	}

	// used — stats events (ts is INTEGER ms). statsDbPath() also throws on a
	// non-hashed repoKey; same guard.
	let evPath: string | null = null;
	try {
		evPath = statsDbPath(repoKey);
	} catch {
		evPath = null;
	}
	if (evPath && fs.existsSync(evPath)) {
		let db: Database.Database | null = null;
		try {
			db = new Database(evPath, { readonly: true });
			const rows = db
				.prepare(
					"SELECT ts FROM tool_calls WHERE tool IN ('get_memory','recall_memory') AND ts > ? AND ts <= ?",
				)
				.all(sinceMs, nowMs) as Array<{ ts: number }>;
			for (const r of rows) {
				const b = bucketOf(r.ts);
				if (b >= 0) used[b]++;
			}
		} catch {
			/* leave used all-zero */
		} finally {
			db?.close();
		}
	}

	return {
		recorded,
		used,
		recordedTotal: recorded.reduce((a, b) => a + b, 0),
		usedTotal: used.reduce((a, b) => a + b, 0),
		buckets: ACTIVITY_BUCKETS,
	};
}
