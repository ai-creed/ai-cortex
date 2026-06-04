// src/lib/cache-store.ts
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./models.js";
import type { RepoCache } from "./models.js";
import {
	transcodeCacheToDb,
	readFromDb,
	dbSchemaValid,
	majorOf,
} from "./cache-store-sqlite.js";

// Re-export so coordinator + tests share one seam (cache-store.js is the mock
// boundary in unit tests; the coordinator gets all its cache deps from here).
export { readFromDb } from "./cache-store-sqlite.js";

const execAsync = promisify(exec);

const HASHED_REPO_KEY_RE = /^[0-9a-f]{16}$/;
const RESERVED_LITERAL_KEYS = new Set(["global"]);

export class RepoKeyError extends Error {}

export function assertHashedRepoKey(repoKey: string): void {
	if (typeof repoKey !== "string") {
		throw new RepoKeyError(
			`Invalid repoKey: expected string, got ${typeof repoKey}`,
		);
	}
	if (RESERVED_LITERAL_KEYS.has(repoKey)) return;
	if (!HASHED_REPO_KEY_RE.test(repoKey)) {
		throw new RepoKeyError(
			`Invalid repoKey ${JSON.stringify(repoKey)}: expected 16-hex hash from resolveRepoIdentity, or reserved literal "global". Hint: pass worktreePath to MCP tools and let the server derive the key.`,
		);
	}
}

export function getCacheDir(repoKey: string): string {
	assertHashedRepoKey(repoKey);
	const home =
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1");
	return path.join(home, repoKey);
}

export function getCacheFilePath(repoKey: string, worktreeKey: string): string {
	return path.join(getCacheDir(repoKey), `${worktreeKey}.json`);
}

export function getCacheDbFilePath(
	repoKey: string,
	worktreeKey: string,
): string {
	return path.join(getCacheDir(repoKey), `${worktreeKey}.db`);
}

export function getCacheMetaFilePath(
	repoKey: string,
	worktreeKey: string,
): string {
	return path.join(getCacheDir(repoKey), `${worktreeKey}.meta.json`);
}

export type CacheMetaSidecar = {
	indexedAt: string | null;
	fingerprint: string | null;
	fileCount: number | null;
	name: string | null;
	/** Origin worktree absolute path. Surfaced for the dashboard hygiene
	 * confirm dialog so users can see WHICH workspace they're about to
	 * delete cache for; spec §confirm dialog requires it when available. */
	worktreePath: string | null;
};

export function deriveCacheMeta(cache: RepoCache): CacheMetaSidecar {
	return {
		indexedAt: cache.indexedAt ?? null,
		fingerprint: cache.fingerprint ?? null,
		fileCount: Array.isArray(cache.files) ? cache.files.length : null,
		name: cache.packageMeta?.name ?? null,
		worktreePath: cache.worktreePath ?? null,
	};
}

export async function buildRepoFingerprint(
	worktreePath: string,
): Promise<string> {
	const { stdout } = await execAsync(
		`git -C ${JSON.stringify(worktreePath)} rev-parse HEAD`,
	);
	return stdout.trimEnd();
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
	const { stdout } = await execAsync(
		`git -C ${JSON.stringify(worktreePath)} status --porcelain -unormal`,
	);
	return stdout.length > 0;
}

export async function writeCache(cache: RepoCache): Promise<void> {
	const dir = getCacheDir(cache.repoKey);
	await fs.promises.mkdir(dir, { recursive: true });

	// Bulk-replace into the per-worktree SQLite db (self-contained single file).
	const dbPath = getCacheDbFilePath(cache.repoKey, cache.worktreeKey);
	transcodeCacheToDb(cache, dbPath);

	// Drop any legacy JSON manifest now that the db is canonical.
	await fs.promises.rm(getCacheFilePath(cache.repoKey, cache.worktreeKey), {
		force: true,
	});

	// Best-effort sidecar: dashboard reads this instead of the full cache.
	// Failure here must not propagate — the db is the source of truth.
	try {
		await writeCacheMetaSidecar(
			cache.repoKey,
			cache.worktreeKey,
			deriveCacheMeta(cache),
		);
	} catch (err) {
		process.stderr.write(
			`ai-cortex: failed to write cache meta sidecar: ${
				err instanceof Error ? err.message : String(err)
			}\n`,
		);
	}
}

export async function writeCacheMetaSidecar(
	repoKey: string,
	worktreeKey: string,
	meta: CacheMetaSidecar,
): Promise<void> {
	const filePath = getCacheMetaFilePath(repoKey, worktreeKey);
	const tmp = filePath + ".tmp";
	await fs.promises.writeFile(tmp, JSON.stringify(meta) + "\n");
	await fs.promises.rename(tmp, filePath);
}

/** Read the two freshness scalars from the db meta table WITHOUT assembling the
 *  whole RepoCache. Used by the coordinator to decide fresh-vs-stale cheaply. */
export function readFreshnessMeta(dbPath: string): {
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
		// Clean up the regenerable WAL sidecars left by a readonly open.
		for (const sfx of ["-wal", "-shm"]) {
			fs.rmSync(dbPath + sfx, { force: true });
		}
	}
}

/** Ensure a valid (current-version) .db exists for the worktree and return its
 *  path, performing legacy-JSON migration, WITHOUT assembling a RepoCache.
 *  Returns null on a cache miss (caller reindexes). */
export async function ensureValidDb(
	repoKey: string,
	worktreeKey: string,
): Promise<string | null> {
	const dbPath = getCacheDbFilePath(repoKey, worktreeKey);
	const jsonPath = getCacheFilePath(repoKey, worktreeKey);

	// 1. Canonical db present.
	if (fs.existsSync(dbPath)) {
		if (dbSchemaValid(dbPath)) {
			// Drop any stale legacy json now that the db is authoritative.
			await fs.promises.rm(jsonPath, { force: true });
			return dbPath;
		}
		// Version mismatch: discard the db (and sidecars) so the caller reindexes.
		for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
			await fs.promises.rm(p, { force: true });
		}
		process.stderr.write(
			`ai-cortex: cache schema updated, reindexing ${worktreeKey}\n`,
		);
		return null;
	}

	// 2. No db, but a legacy json exists: migrate in place (transcode) or reindex.
	if (fs.existsSync(jsonPath)) {
		let cache: RepoCache;
		try {
			cache = JSON.parse(
				await fs.promises.readFile(jsonPath, "utf8"),
			) as RepoCache;
		} catch {
			await fs.promises.rm(jsonPath, { force: true }); // corrupt -> reindex
			return null;
		}
		if (majorOf(cache.schemaVersion ?? "") !== majorOf(SCHEMA_VERSION)) {
			await fs.promises.rm(jsonPath, { force: true }); // incompatible -> reindex
			return null;
		}
		try {
			transcodeCacheToDb(cache, dbPath);
		} catch {
			// transcodeCacheToDb cleans up its own private tmp on failure.
			await fs.promises.rm(jsonPath, { force: true });
			return null; // transcode failure -> reindex
		}
		// Ensure a sidecar exists even if the legacy json had none.
		try {
			await writeCacheMetaSidecar(repoKey, worktreeKey, deriveCacheMeta(cache));
		} catch {
			// sidecar is best-effort; the db is authoritative
		}
		await fs.promises.rm(jsonPath, { force: true });
		return dbPath;
	}

	// 3. Nothing on disk: first index.
	return null;
}

export async function readCacheForWorktree(
	repoKey: string,
	worktreeKey: string,
): Promise<RepoCache | null> {
	const dbPath = await ensureValidDb(repoKey, worktreeKey);
	return dbPath ? readFromDb(dbPath) : null;
}
