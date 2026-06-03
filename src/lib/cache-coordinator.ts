// src/lib/cache-coordinator.ts
import Database from "better-sqlite3";
import {
	buildRepoFingerprint,
	ensureValidDb,
	getCacheDbFilePath,
	isWorktreeDirty,
	writeCache,
} from "./cache-store.js";
import { readFromDb } from "./cache-store-sqlite.js";
import { diffChangedFiles } from "./diff-files.js";
import { buildIncrementalIndex, indexRepo } from "./indexer.js";
import type { RepoCache, RepoIdentity } from "./models.js";

export type CacheResolutionOptions = { stale?: boolean };
export type CacheResolutionResult = {
	cache: RepoCache;
	cacheStatus: "fresh" | "reindexed" | "stale";
};
export type FreshDbResult = {
	dbPath: string;
	cacheStatus: "fresh" | "reindexed" | "stale";
	rebuiltCache?: RepoCache;
};

/** Read the two freshness scalars from the db meta table without assembling. */
function readFreshnessMeta(dbPath: string): {
	fingerprint: string | null;
	dirtyAtIndex: boolean | undefined;
} {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT key, value FROM meta WHERE key IN ('fingerprint','dirtyAtIndex')",
			)
			.all() as Array<{ key: string; value: string }>;
		const m = new Map(rows.map((r) => [r.key, r.value]));
		return {
			fingerprint: m.get("fingerprint") ?? null,
			dirtyAtIndex: m.has("dirtyAtIndex")
				? m.get("dirtyAtIndex") === "1"
				: undefined,
		};
	} finally {
		db.close();
	}
}

/** Ensure the worktree's .db is fresh-or-rebuilt and return its path WITHOUT
 *  materializing a RepoCache on the fresh / options.stale paths. The stale
 *  incremental rebuild needs the prior graph, so it materializes once and returns
 *  it via `rebuiltCache` (so the whole-load wrapper does not double-read). */
export async function ensureFreshDb(
	identity: RepoIdentity,
	options: CacheResolutionOptions,
): Promise<FreshDbResult> {
	const validPath = await ensureValidDb(identity.repoKey, identity.worktreeKey);
	if (!validPath) {
		const cache = await indexRepo(identity.worktreePath);
		return {
			dbPath: getCacheDbFilePath(cache.repoKey, cache.worktreeKey),
			cacheStatus: "reindexed",
			rebuiltCache: cache,
		};
	}

	const meta = readFreshnessMeta(validPath);
	const fingerprint = await buildRepoFingerprint(identity.worktreePath);
	const fingerprintStale = meta.fingerprint !== fingerprint;
	const dirty = await isWorktreeDirty(identity.worktreePath);
	const dirtyReverted = !dirty && !!meta.dirtyAtIndex;
	const isStale = fingerprintStale || dirty || dirtyReverted;

	if (!isStale) return { dbPath: validPath, cacheStatus: "fresh" };
	if (options.stale) return { dbPath: validPath, cacheStatus: "stale" };

	// Stale rebuild: the incremental indexer needs the prior graph, so materialize
	// ONCE here (transient; not retained by blast).
	const cached = readFromDb(validPath);
	if (!cached) {
		const cache = await indexRepo(identity.worktreePath);
		return {
			dbPath: getCacheDbFilePath(cache.repoKey, cache.worktreeKey),
			cacheStatus: "reindexed",
			rebuiltCache: cache,
		};
	}
	const diff = await diffChangedFiles(identity, cached, {
		forceHashCompare: dirtyReverted,
	});
	const cache = await buildIncrementalIndex(identity, cached, diff, dirty);
	await writeCache(cache);
	return {
		dbPath: getCacheDbFilePath(cache.repoKey, cache.worktreeKey),
		cacheStatus: "reindexed",
		rebuiltCache: cache,
	};
}

export async function resolveCacheWithFreshness(
	identity: RepoIdentity,
	options: CacheResolutionOptions,
): Promise<CacheResolutionResult> {
	const r = await ensureFreshDb(identity, options);
	const cache = r.rebuiltCache ?? (await materialize(r.dbPath, identity));
	return { cache, cacheStatus: r.cacheStatus };
}

async function materialize(
	dbPath: string,
	identity: RepoIdentity,
): Promise<RepoCache> {
	const cache = readFromDb(dbPath);
	if (cache) return cache;
	// Extremely defensive: db vanished between ensure and read -> reindex.
	return indexRepo(identity.worktreePath);
}
