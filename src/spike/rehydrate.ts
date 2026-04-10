import type { RehydrateResult, RepoCache } from "./models.js";

export function rehydrateFromCache(cache: RepoCache): RehydrateResult {
	const priorityDocs = cache.docs.slice(0, 3).map(doc => doc.path);
	const priorityFiles = cache.imports
		.slice(0, 8)
		.flatMap(edge => [edge.from, edge.to])
		.filter((value, index, arr) => arr.indexOf(value) === index)
		.slice(0, 6);
	const summaryLines = [
		`Project: ${cache.docs[0]?.title || cache.repoPath}`,
		`Indexed: ${cache.indexedAt}`,
		`Top docs: ${priorityDocs.join(", ") || "none"}`,
		`Likely entry files: ${priorityFiles.join(", ") || "none"}`
	];

	return {
		summary: summaryLines.join("\n"),
		priorityDocs,
		priorityFiles,
		stale: false,
		cacheStatus: "fresh"
	};
}
