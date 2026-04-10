// src/lib/diff-files.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RepoCache, RepoIdentity } from "./models.js";
import { listIndexableFiles } from "./indexable-files.js";

export type FilesDiff = {
	changed: string[];
	removed: string[];
	method: "git-diff" | "hash-compare";
};

export function hashFileContent(
	worktreePath: string,
	filePath: string,
): string {
	const content = fs.readFileSync(path.join(worktreePath, filePath));
	return createHash("sha256").update(content).digest("hex");
}

function diffByHashCompare(
	worktreePath: string,
	cached: RepoCache,
): FilesDiff {
	const currentFiles = new Set(listIndexableFiles(worktreePath));
	const cachedHashByPath = new Map(
		cached.files.map((f) => [f.path, f.contentHash]),
	);

	const changed: string[] = [];
	const removed: string[] = [];

	// Check current files against cached
	for (const filePath of currentFiles) {
		const cachedHash = cachedHashByPath.get(filePath);
		if (!cachedHash) {
			changed.push(filePath);
			continue;
		}
		const currentHash = hashFileContent(worktreePath, filePath);
		if (currentHash !== cachedHash) {
			changed.push(filePath);
		}
	}

	// Check for removed files
	for (const [cachedPath] of cachedHashByPath) {
		if (!currentFiles.has(cachedPath)) {
			removed.push(cachedPath);
		}
	}

	return { changed, removed, method: "hash-compare" };
}

export function diffChangedFiles(
	identity: RepoIdentity,
	cached: RepoCache,
): FilesDiff {
	// For now, only hash-compare tier. Git-diff tier added in Task 5.
	return diffByHashCompare(identity.worktreePath, cached);
}
