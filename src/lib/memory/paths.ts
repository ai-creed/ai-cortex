// src/lib/memory/paths.ts
import path from "node:path";
import { getCacheDir } from "../cache-store.js";

export function memoryRootDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "memory");
}

export function memoriesDir(repoKey: string): string {
	return path.join(memoryRootDir(repoKey), "memories");
}

export function trashDir(repoKey: string): string {
	return path.join(memoryRootDir(repoKey), "trash");
}

export function indexDbPath(repoKey: string): string {
	return path.join(memoryRootDir(repoKey), "index.sqlite");
}

export function typesJsonPath(repoKey: string): string {
	return path.join(memoryRootDir(repoKey), "types.json");
}

export function extractorRunsDir(repoKey: string): string {
	return path.join(memoryRootDir(repoKey), "extractor-runs");
}

export function extractorRunPath(repoKey: string, sessionId: string): string {
	return path.join(extractorRunsDir(repoKey), `${sessionId}.json`);
}

export function memoryFilePath(
	repoKey: string,
	memoryId: string,
	location: "memories" | "trash",
): string {
	const dir =
		location === "memories" ? memoriesDir(repoKey) : trashDir(repoKey);
	return path.join(dir, `${memoryId}.md`);
}
