// src/lib/indexer.ts
import {
	buildRepoFingerprint,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
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
		const files = filePaths.map((p) => ({ path: p, kind: "file" as const }));

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

export function getCachedIndex(repoPath: string): RepoCache | null {
	const identity = resolveRepoIdentity(repoPath);
	const cached = readCacheForWorktree(identity.repoKey, identity.worktreeKey);
	if (!cached) return null;
	const currentFingerprint = buildRepoFingerprint(identity.worktreePath);
	if (cached.fingerprint !== currentFingerprint) return null;
	return cached;
}
