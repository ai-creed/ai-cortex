// src/lib/stats/paths.ts
import path from "node:path";
import os from "node:os";
import { getCacheDir } from "../cache-store.js";

export function cacheRoot(): string {
	return (
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1")
	);
}

export function statsDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "stats");
}

export function statsDbPath(repoKey: string): string {
	return path.join(statsDir(repoKey), "events.sqlite");
}

export function statsConfigPath(): string {
	return path.join(cacheRoot(), "stats-config.json");
}

export function archiveDir(repoKey: string): string {
	return path.join(cacheRoot(), "_archived", repoKey);
}
