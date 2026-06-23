// src/lib/library/paths.ts
import os from "node:os";
import path from "node:path";

// The library is user-global: it lives beside the repo-keyed tiers, not under one.
export function libraryRoot(): string {
	const home =
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1");
	return path.join(home, "library");
}

export function sourcesJsonPath(): string {
	return path.join(libraryRoot(), "sources.json");
}
export function sourceDir(sourceId: string): string {
	return path.join(libraryRoot(), sourceId);
}
export function indexDbPath(sourceId: string): string {
	return path.join(sourceDir(sourceId), "index.sqlite");
}
export function manifestPath(sourceId: string): string {
	return path.join(sourceDir(sourceId), "manifest.json");
}
export function annotationsDbPath(sourceId: string): string {
	return path.join(sourceDir(sourceId), "annotations.sqlite");
}
export function telemetryDbPath(): string {
	return path.join(libraryRoot(), "telemetry.sqlite");
}
