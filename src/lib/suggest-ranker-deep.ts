// src/lib/suggest-ranker-deep.ts — stub; real implementation in Task 9.
import type { RepoCache } from "./models.js";
import type { DeepSuggestItem } from "./suggest.js";

export type DeepRankResult = {
	results: DeepSuggestItem[];
	poolSize: number;
	contentScanTruncated?: boolean;
	staleMixedEvidence?: boolean;
};

export async function rankSuggestionsDeep(
	_task: string,
	_cache: RepoCache,
	_worktreePath: string,
	_opts: { from?: string | null; limit?: number; poolSize?: number; stale?: boolean },
): Promise<DeepRankResult> {
	throw new Error("rankSuggestionsDeep not yet implemented");
}
