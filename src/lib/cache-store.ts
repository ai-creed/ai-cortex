// src/lib/cache-store.ts
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SCHEMA_VERSION } from "./models.js";
import type { RepoCache } from "./models.js";

const execAsync = promisify(exec);

export function getCacheDir(repoKey: string): string {
	const home = process.env.AI_CORTEX_CACHE_HOME ?? path.join(os.homedir(), ".cache", "ai-cortex", "v1");
	return path.join(home, repoKey);
}

export function getCacheFilePath(repoKey: string, worktreeKey: string): string {
	return path.join(getCacheDir(repoKey), `${worktreeKey}.json`);
}

export async function buildRepoFingerprint(worktreePath: string): Promise<string> {
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
	const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as RepoCache;
	if (raw.schemaVersion !== SCHEMA_VERSION) {
		await fs.promises.rm(filePath, { force: true });
		process.stderr.write(
			`ai-cortex: cache schema updated, reindexing ${worktreeKey}\n`,
		);
		return null;
	}
	return raw;
}
