import { buildCache } from "./build-cache.js";
import { rehydrateFromCache } from "./rehydrate.js";

export async function runPhase0(repoPath = process.cwd()): Promise<void> {
	const cache = buildCache(repoPath);
	const result = rehydrateFromCache(cache);
	process.stdout.write(result.summary + "\n");
}
