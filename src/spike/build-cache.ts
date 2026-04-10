import fs from "node:fs";
import path from "node:path";
import { writeCache } from "./cache-store.js";
import { loadDocs } from "./doc-inputs.js";
import { collectFileTree } from "./file-tree.js";
import type { RepoCache } from "./models.js";
import { getRepoKey } from "./repo-id.js";
import { extractImportEdgesFromSource } from "./ts-import-graph.js";

export function buildCache(repoPath: string): RepoCache {
	const files = collectFileTree(repoPath);
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
		files,
		docs,
		imports
	};

	writeCache(cache);
	return cache;
}
