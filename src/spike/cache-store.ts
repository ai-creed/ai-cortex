import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoCache } from "./models.js";

export function getCacheDir(): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "phase0");
}

export function writeCache(cache: RepoCache): string {
	const dir = getCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${cache.repoKey}.json`);
	fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + "\n");
	return filePath;
}

export function readCache(cacheFile: string): RepoCache {
	return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as RepoCache;
}
