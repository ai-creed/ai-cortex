// src/lib/diff-files.ts
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoCache, RepoIdentity } from "./models.js";
import { listIndexableFiles } from "./indexable-files.js";

const execAsync = promisify(exec);

export type FilesDiff = {
	changed: string[];
	removed: string[];
	method: "git-diff" | "hash-compare";
};

export function hashFileContent(
	worktreePath: string,
	filePath: string,
	content?: string,
): string {
	const data =
		content !== undefined
			? content
			: fs.readFileSync(path.join(worktreePath, filePath));
	return createHash("sha256").update(data).digest("hex");
}

async function diffByHashCompare(
	worktreePath: string,
	cached: RepoCache,
): Promise<FilesDiff> {
	const currentFiles = new Set(await listIndexableFiles(worktreePath));
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

async function gitDiffNames(
	worktreePath: string,
	args: string[],
): Promise<string[]> {
	const { stdout } = await execAsync(
		`git -C ${JSON.stringify(worktreePath)} ${args.join(" ")}`,
	);
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

async function diffByGitDiff(
	worktreePath: string,
	cached: RepoCache,
): Promise<FilesDiff | null> {
	try {
		// Committed changes since cached fingerprint
		const committed = await gitDiffNames(worktreePath, [
			"diff",
			"--name-only",
			`${cached.fingerprint}..HEAD`,
		]);
		// Unstaged changes
		const unstaged = await gitDiffNames(worktreePath, ["diff", "--name-only"]);
		// Staged changes
		const staged = await gitDiffNames(worktreePath, [
			"diff",
			"--name-only",
			"--cached",
		]);
		// Untracked files
		const untracked = await gitDiffNames(worktreePath, [
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
		const currentFiles = new Set(await listIndexableFiles(worktreePath));

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

export type DiffOptions = {
	forceHashCompare?: boolean;
};

export async function diffChangedFiles(
	identity: RepoIdentity,
	cached: RepoCache,
	options?: DiffOptions,
): Promise<FilesDiff> {
	if (!options?.forceHashCompare) {
		const gitResult = await diffByGitDiff(identity.worktreePath, cached);
		if (gitResult) return gitResult;
	}
	return diffByHashCompare(identity.worktreePath, cached);
}
