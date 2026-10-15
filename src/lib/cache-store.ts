// src/lib/cache-store.ts
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./models.js";
import type { RepoCache, FileNode } from "./models.js";
import {
	transcodeCacheToDb,
	readFromDb,
	dbSchemaValid,
} from "./cache-store-sqlite.js";
import type { ReadOptions } from "./cache-store-sqlite.js";
import { withSequenceLock } from "./seq-lock.js";

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
/** A4: sha1 over sorted (path, contentHash) pairs joined with newlines. */
export function computeContentFingerprint(files: FileNode[]): string {
	const lines = files.map((f) => `${f.path}\t${f.contentHash ?? ""}`).sort();
	return createHash("sha1").update(lines.join("\n")).digest("hex");
}

export function readFreshnessMeta(dbPath: string): {
	fingerprint: string | null;
	dirtyAtIndex: boolean | undefined;
	indexSeq: number | null;
	contentFingerprint: string | null;
	schemaVersion: string | null;
} {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT key, value FROM meta WHERE key IN ('fingerprint','dirtyAtIndex','indexSeq','contentFingerprint','schemaVersion')",
			)
			.all() as Array<{ key: string; value: string }>;
		const m = new Map(rows.map((r) => [r.key, r.value]));
		return {
			fingerprint: m.get("fingerprint") ?? null,
			dirtyAtIndex: m.has("dirtyAtIndex")
				? m.get("dirtyAtIndex") === "1"
				: undefined,
			indexSeq: m.has("indexSeq") ? Number(m.get("indexSeq")) : null,
			contentFingerprint: m.get("contentFingerprint") ?? null,
			schemaVersion: m.get("schemaVersion") ?? null,
		};
	} finally {
		db.close();
		// Clean up the regenerable WAL sidecars left by a readonly open.
		for (const sfx of ["-wal", "-shm"]) {
			fs.rmSync(dbPath + sfx, { force: true });
		}
	}
}

let ensureValidDbTestHooks: { beforeLock?: () => Promise<void> } | null = null;
/** Test-only seam: pause between the unlocked validity check and the lock. */
export function setEnsureValidDbTestHooks(
	h: { beforeLock?: () => Promise<void> } | null,
): void {
	ensureValidDbTestHooks = h;
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
		// Invalid: discard under the sequence lock with a recheck (spec B4), so a
		// store another process published after our unlocked check is never
		// deleted. The sequence sidecar is left in place.
		if (ensureValidDbTestHooks?.beforeLock) {
			await ensureValidDbTestHooks.beforeLock();
		}
		const outcome = withSequenceLock(
			dbPath,
			(): "valid" | "absent" | "discarded" => {
				if (!fs.existsSync(dbPath)) return "absent";
				if (dbSchemaValid(dbPath)) return "valid";
				for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
					fs.rmSync(p, { force: true });
				}
				return "discarded";
			},
		);
		if (outcome === "valid") {
			await fs.promises.rm(jsonPath, { force: true });
			return dbPath;
		}
		if (outcome === "discarded") {
			process.stderr.write(
				`ai-cortex: cache schema updated, reindexing ${worktreeKey}\n`,
			);
			return null;
		}
		// "absent": another process discarded it; continue as if no db existed.
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
		if (cache.schemaVersion !== SCHEMA_VERSION) {
			// Older or newer minor (or any other version) -> reindex (A1).
			await fs.promises.rm(jsonPath, { force: true });
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
	options: ReadOptions = {},
): Promise<RepoCache | null> {
	const dbPath = await ensureValidDb(repoKey, worktreeKey);
	return dbPath ? readFromDb(dbPath, options) : null;
}
