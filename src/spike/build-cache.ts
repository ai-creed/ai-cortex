import fs from "node:fs";
import path from "node:path";
import { buildRepoFingerprint, writeCache, writeSummaryCache } from "./cache-store.js";
import { loadDocs } from "./doc-inputs.js";
import { buildIndexableTree } from "./indexable-files.js";
import type { RepoCache } from "./models.js";
import { rehydrateFromCache } from "./rehydrate.js";
import { getRepoKey } from "./repo-id.js";
import { extractImportEdgesFromSource } from "./ts-import-graph.js";

export function buildCache(repoPath: string): RepoCache {
	const files = buildIndexableTree(repoPath);
	const filePaths = files.filter(node => node.kind === "file").map(node => node.path);
	const docs = loadDocs(repoPath, filePaths);
	const imports = filePaths
		.filter(filePath => /\.(ts|tsx|js|jsx)$/u.test(filePath))
		.flatMap(filePath => {
			const source = fs.readFileSync(path.join(repoPath, filePath), "utf8");
			return extractImportEdgesFromSource(filePath, source);
		});

	const cache: RepoCache = {
		repoPath,
		repoKey: getRepoKey(repoPath),
		indexedAt: new Date().toISOString(),
		fingerprint: buildRepoFingerprint(repoPath),
		files,
		docs,
		imports
	};

	writeCache(cache);
	const summary = rehydrateFromCache(cache);
	writeSummaryCache({
		repoKey: cache.repoKey,
		indexedAt: cache.indexedAt,
		fingerprint: cache.fingerprint,
		summary: summary.summary,
		priorityDocs: summary.priorityDocs,
		priorityFiles: summary.priorityFiles
	});
	return cache;
}
