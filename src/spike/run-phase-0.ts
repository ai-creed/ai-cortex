import { buildCache } from "./build-cache.js";
import { buildRepoFingerprint, readSummaryCacheForRepo } from "./cache-store.js";
import { getRepoKey } from "./repo-id.js";
import { rehydrateFromCache } from "./rehydrate.js";
import type { RehydrateResult } from "./models.js";

type RunPhase0Options = {
	refresh?: boolean;
	writeToStdout?: boolean;
};

export async function runPhase0(
	repoPath = process.cwd(),
	options: RunPhase0Options = {}
): Promise<RehydrateResult> {
	const { refresh = false, writeToStdout = false } = options;
	const repoKey = getRepoKey(repoPath);
	const existing = refresh ? null : readSummaryCacheForRepo(repoKey);

	let result: RehydrateResult;
	if (existing) {
		const currentFingerprint = buildRepoFingerprint(repoPath);
		result = {
			summary: existing.summary,
			priorityDocs: existing.priorityDocs,
			priorityFiles: existing.priorityFiles,
			stale: existing.fingerprint !== currentFingerprint,
			cacheStatus: existing.fingerprint === currentFingerprint ? "fresh" : "stale"
		};
	} else {
		const cache = buildCache(repoPath);
		result = {
			...rehydrateFromCache(cache),
			stale: false,
			cacheStatus: "missing"
		};
	}

	if (writeToStdout) process.stdout.write(result.summary + "\n");
	return result;
}
