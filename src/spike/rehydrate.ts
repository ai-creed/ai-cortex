import { pickPriorityFiles } from "./entry-files.js";
import type { RehydrateResult, RepoCache } from "./models.js";

export function rehydrateFromCache(cache: RepoCache): RehydrateResult {
	const priorityDocs = cache.docs.slice(0, 3).map(doc => doc.path);
	const priorityFiles = pickPriorityFiles(
		cache.files.filter(node => node.kind === "file").map(node => node.path),
		6
	);
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
