// src/lib/indexer.ts
import {
	buildRepoFingerprint,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
import { hashFileContent } from "./diff-files.js";
import type { FilesDiff } from "./diff-files.js";
import { loadDocs } from "./doc-inputs.js";
import { readPackageMeta, pickEntryFiles } from "./entry-files.js";
import { extractImports } from "./import-graph.js";
import { listIndexableFiles } from "./indexable-files.js";
import { SCHEMA_VERSION, IndexError, RepoIdentityError } from "./models.js";
import type { RepoCache, RepoIdentity } from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";

export function buildIndex(identity: RepoIdentity): RepoCache {
	try {
		const filePaths = listIndexableFiles(identity.worktreePath);
		const packageMeta = readPackageMeta(identity.worktreePath);
		const entryFiles = pickEntryFiles(filePaths, packageMeta);
		const docs = loadDocs(identity.worktreePath, filePaths);
		const imports = extractImports(identity.worktreePath, filePaths);
		const fingerprint = buildRepoFingerprint(identity.worktreePath);
		const files = filePaths.map((p) => ({
			path: p,
			kind: "file" as const,
			contentHash: hashFileContent(identity.worktreePath, p),
		}));

		return {
			schemaVersion: SCHEMA_VERSION,
			repoKey: identity.repoKey,
			worktreeKey: identity.worktreeKey,
			worktreePath: identity.worktreePath,
			indexedAt: new Date().toISOString(),
			fingerprint,
			packageMeta,
			entryFiles,
			files,
			docs,
			imports,
		};
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}

export function indexRepo(repoPath: string): RepoCache {
	const identity = resolveRepoIdentity(repoPath);
	const cache = buildIndex(identity);
	writeCache(cache);
	return cache;
}

export function buildIncrementalIndex(
	identity: RepoIdentity,
	existingCache: RepoCache,
	diff: FilesDiff,
	dirtyAtIndex: boolean,
): RepoCache {
	const fingerprint = buildRepoFingerprint(identity.worktreePath);
	const indexedAt = new Date().toISOString();

	// Empty diff — timestamp-only refresh
	if (diff.changed.length === 0 && diff.removed.length === 0) {
		return { ...existingCache, fingerprint, indexedAt, dirtyAtIndex };
	}

	const changedSet = new Set(diff.changed);
	const removedSet = new Set(diff.removed);
	const touchedSet = new Set([...diff.changed, ...diff.removed]);

	// --- files[] ---
	const keptFiles = existingCache.files.filter(
		(f) => !changedSet.has(f.path) && !removedSet.has(f.path),
	);
	const newFiles = diff.changed.map((p) => ({
		path: p,
		kind: "file" as const,
		contentHash: hashFileContent(identity.worktreePath, p),
	}));
	const files = [...keptFiles, ...newFiles].sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	const allFilePaths = files.map((f) => f.path);

	// --- imports[] ---
	const keptImports = existingCache.imports.filter(
		(e) => !changedSet.has(e.from) && !removedSet.has(e.from),
	);
	const changedTsFiles = diff.changed.filter((p) =>
		/\.(ts|tsx|js|jsx)$/.test(p),
	);
	const newImports = extractImports(identity.worktreePath, changedTsFiles);
	const imports = [...keptImports, ...newImports];

	// --- packageMeta ---
	const packageJsonTouched =
		changedSet.has("package.json") || removedSet.has("package.json");
	const packageMeta = packageJsonTouched
		? readPackageMeta(identity.worktreePath)
		: existingCache.packageMeta;

	// --- entryFiles[] ---
	const entryFiles = pickEntryFiles(allFilePaths, packageMeta);

	// --- docs[] ---
	const anyMdTouched = [...touchedSet].some((p) => p.endsWith(".md"));
	const docs = anyMdTouched
		? loadDocs(identity.worktreePath, allFilePaths)
		: existingCache.docs;

	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: identity.repoKey,
		worktreeKey: identity.worktreeKey,
		worktreePath: identity.worktreePath,
		indexedAt,
		fingerprint,
		dirtyAtIndex,
		packageMeta,
		entryFiles,
		files,
		docs,
		imports,
	};
}

export function getCachedIndex(repoPath: string): RepoCache | null {
	const identity = resolveRepoIdentity(repoPath);
	const cached = readCacheForWorktree(identity.repoKey, identity.worktreeKey);
	if (!cached) return null;
	const currentFingerprint = buildRepoFingerprint(identity.worktreePath);
	if (cached.fingerprint !== currentFingerprint) return null;
	return cached;
}
