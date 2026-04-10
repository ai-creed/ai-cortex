// src/lib/diff-files.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

function gitDiffNames(
	worktreePath: string,
	args: string[],
): string[] {
	const output = execFileSync("git", ["-C", worktreePath, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return output
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function diffByGitDiff(
	worktreePath: string,
	cached: RepoCache,
): FilesDiff | null {
	try {
		// Committed changes since cached fingerprint
		const committed = gitDiffNames(worktreePath, [
			"diff",
			"--name-only",
			`${cached.fingerprint}..HEAD`,
		]);
		// Unstaged changes
		const unstaged = gitDiffNames(worktreePath, ["diff", "--name-only"]);
		// Staged changes
		const staged = gitDiffNames(worktreePath, [
			"diff",
			"--name-only",
			"--cached",
		]);
		// Untracked files
		const untracked = gitDiffNames(worktreePath, [
			"ls-files",
			"--others",
			"--exclude-standard",
		]);

		const rawCandidates = new Set([
			...committed,
			...unstaged,
			...staged,
			...untracked,
		]);

		// Filter candidates to indexable files only — git diff may include
		// files that listIndexableFiles excludes (binaries, non-source, etc.)
		const currentFiles = new Set(listIndexableFiles(worktreePath));

		// Hash validation: filter out files whose content already matches cached hash
		const cachedHashByPath = new Map(
			cached.files.map((f) => [f.path, f.contentHash]),
		);
		const changed: string[] = [];
		for (const filePath of rawCandidates) {
			if (!currentFiles.has(filePath)) continue; // not indexable
			const cachedHash = cachedHashByPath.get(filePath);
			if (cachedHash) {
				const currentHash = hashFileContent(worktreePath, filePath);
				if (currentHash === cachedHash) continue; // already processed
			}
			changed.push(filePath);
		}
		const removed: string[] = [];
		for (const file of cached.files) {
			if (!currentFiles.has(file.path)) {
				removed.push(file.path);
			}
		}

		return { changed, removed, method: "git-diff" };
	} catch {
		// git diff failed (e.g., unreachable ancestor commit) — fall back
		return null;
	}
}

export function diffChangedFiles(
	identity: RepoIdentity,
	cached: RepoCache,
): FilesDiff {
	const gitResult = diffByGitDiff(identity.worktreePath, cached);
	if (gitResult) return gitResult;
	return diffByHashCompare(identity.worktreePath, cached);
}
