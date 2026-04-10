// src/lib/cache-store.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION } from "./models.js";
import type { RepoCache } from "./models.js";

export function getCacheDir(repoKey: string): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "v1", repoKey);
}

export function getCacheFilePath(repoKey: string, worktreeKey: string): string {
	return path.join(getCacheDir(repoKey), `${worktreeKey}.json`);
}

export function buildRepoFingerprint(worktreePath: string): string {
	return execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"]
	}).trimEnd();
}

export function writeCache(cache: RepoCache): void {
	const dir = getCacheDir(cache.repoKey);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = getCacheFilePath(cache.repoKey, cache.worktreeKey);
	fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + "\n");
}

export function readCacheForWorktree(repoKey: string, worktreeKey: string): RepoCache | null {
	const filePath = getCacheFilePath(repoKey, worktreeKey);
	if (!fs.existsSync(filePath)) return null;
	const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RepoCache;
	if (raw.schemaVersion !== SCHEMA_VERSION) {
		fs.rmSync(filePath, { force: true });
		process.stderr.write(`ai-cortex: cache schema updated, reindexing ${worktreeKey}\n`);
		return null;
	}
	return raw;
}
