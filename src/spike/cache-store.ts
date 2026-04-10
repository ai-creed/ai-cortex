import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { RepoCache, RepoSummaryCache } from "./models.js";
import { listIndexableFiles } from "./indexable-files.js";

export function getCacheDir(): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "phase0");
}

export function getCacheFilePath(repoKey: string): string {
	return path.join(getCacheDir(), `${repoKey}.json`);
}

export function getSummaryCacheFilePath(repoKey: string): string {
	return path.join(getCacheDir(), `${repoKey}.summary.json`);
}

function execGit(repoPath: string, args: string[]): string {
	return execFileSync("git", ["-C", repoPath, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"]
	}).trimEnd();
}

function buildGitAwareFingerprint(repoPath: string): string {
	const hash = createHash("sha256");
	const head = execGit(repoPath, ["rev-parse", "HEAD"]);

	hash.update(head);
	return hash.digest("hex");
}

function buildFallbackFingerprint(repoPath: string): string {
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

export function buildRepoFingerprint(repoPath: string): string {
	try {
		return buildGitAwareFingerprint(repoPath);
	} catch {
		return buildFallbackFingerprint(repoPath);
	}
}

export function writeCache(cache: RepoCache): string {
	const dir = getCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = getCacheFilePath(cache.repoKey);
	fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + "\n");
	return filePath;
}

export function writeSummaryCache(summary: RepoSummaryCache): string {
	const dir = getCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = getSummaryCacheFilePath(summary.repoKey);
	fs.writeFileSync(filePath, JSON.stringify(summary, null, 2) + "\n");
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

export function readSummaryCache(cacheFile: string): RepoSummaryCache {
	return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as RepoSummaryCache;
}

export function readSummaryCacheForRepo(repoKey: string): RepoSummaryCache | null {
	const filePath = getSummaryCacheFilePath(repoKey);
	if (!fs.existsSync(filePath)) return null;
	return readSummaryCache(filePath);
}
