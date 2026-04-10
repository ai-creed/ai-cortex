import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RepoCache } from "./models.js";
import { listIndexableFiles } from "./indexable-files.js";

export function getCacheDir(): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "phase0");
}

export function getCacheFilePath(repoKey: string): string {
	return path.join(getCacheDir(), `${repoKey}.json`);
}

export function buildRepoFingerprint(repoPath: string): string {
	const hash = createHash("sha256");
	const files = listIndexableFiles(repoPath);

	for (const filePath of files) {
		const abs = path.join(repoPath, filePath);
		const stat = fs.statSync(abs);
		hash.update(filePath);
		hash.update(String(stat.size));
		hash.update(String(stat.mtimeMs));
	}

	return hash.digest("hex");
}

export function writeCache(cache: RepoCache): string {
	const dir = getCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = getCacheFilePath(cache.repoKey);
	fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + "\n");
	return filePath;
}

export function readCache(cacheFile: string): RepoCache {
	return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as RepoCache;
}

export function readCacheForRepo(repoKey: string): RepoCache | null {
	const filePath = getCacheFilePath(repoKey);
	if (!fs.existsSync(filePath)) return null;
	return readCache(filePath);
}
