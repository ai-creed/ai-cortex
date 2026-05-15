// src/lib/stats/paths.ts
import path from "node:path";
import { getCacheDir } from "../cache-store.js";

export function statsDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "stats");
}

export function statsDbPath(repoKey: string): string {
	return path.join(statsDir(repoKey), "events.sqlite");
}
