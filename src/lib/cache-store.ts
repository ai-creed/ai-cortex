// src/lib/cache-store.ts
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SCHEMA_VERSION } from "./models.js";
import type { RepoCache } from "./models.js";

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
};

export function deriveCacheMeta(cache: RepoCache): CacheMetaSidecar {
	return {
		indexedAt: cache.indexedAt ?? null,
		fingerprint: cache.fingerprint ?? null,
		fileCount: Array.isArray(cache.files) ? cache.files.length : null,
		name: cache.packageMeta?.name ?? null,
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
	const filePath = getCacheFilePath(cache.repoKey, cache.worktreeKey);
	const tmp = filePath + ".tmp";
	await fs.promises.writeFile(tmp, JSON.stringify(cache, null, 2) + "\n");
	await fs.promises.rename(tmp, filePath);

	// Best-effort sidecar: dashboard reads this instead of the full cache JSON.
	// Failure here must not propagate — main JSON is the source of truth.
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

export async function readCacheForWorktree(
	repoKey: string,
	worktreeKey: string,
): Promise<RepoCache | null> {
	const filePath = getCacheFilePath(repoKey, worktreeKey);
	try {
		await fs.promises.access(filePath);
	} catch {
		return null;
	}
	const raw = JSON.parse(
		await fs.promises.readFile(filePath, "utf8"),
	) as RepoCache;
	if (raw.schemaVersion !== SCHEMA_VERSION) {
		await fs.promises.rm(filePath, { force: true });
		process.stderr.write(
			`ai-cortex: cache schema updated, reindexing ${worktreeKey}\n`,
		);
		return null;
	}
	return raw;
}
