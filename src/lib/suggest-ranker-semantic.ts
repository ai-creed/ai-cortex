// src/lib/suggest-ranker-semantic.ts
import { getProvider, MODEL_NAME } from "./embed-provider.js";
import { buildVectorIndex, getSidecarDir, refreshVectorIndex } from "./vector-builder.js";
import { readVectorIndex } from "./vector-sidecar.js";
import type { VectorIndex } from "./vector-sidecar.js";
import type { RepoCache } from "./models.js";

export type SemanticResult = {
	path: string;
	kind: "file" | "doc";
	score: number;
	reason: string;
};

export type SemanticRankResult = {
	results: SemanticResult[];
	poolSize: number;
};

export async function rankSuggestionsSemanticCore(
	task: string,
	cache: RepoCache,
	worktreePath: string,
	options?: { limit?: number; stale?: boolean },
): Promise<SemanticRankResult> {
	const sidecarDir = getSidecarDir(cache.worktreeKey);

	// readVectorIndex throws VectorIndexCorruptError if corrupt — let it propagate
	let index: VectorIndex | null = await readVectorIndex(sidecarDir, MODEL_NAME);

	if (index === null) {
		index = await buildVectorIndex(worktreePath, cache);
	} else if (options?.stale) {
		index = await refreshVectorIndex(worktreePath, cache, index);
	}

	const provider = await getProvider();
	const [taskVec] = await provider.embed([task]);
	if (!taskVec) throw new Error("embed returned no vector for task");

	const results = cosineTopK(taskVec, index, options?.limit ?? 10);

	return { results, poolSize: index.meta.count };
}

function cosineTopK(
	query: Float32Array,
	index: VectorIndex,
	k: number,
): SemanticResult[] {
	const { matrix, meta } = index;
	const dim = meta.dim;
	const scored: SemanticResult[] = [];

	for (let i = 0; i < meta.count; i++) {
		const entry = meta.entries[i]!;
		let dot = 0;
		const offset = i * dim;
		for (let j = 0; j < dim; j++) {
			dot += query[j]! * matrix[offset + j]!;
		}
		const kind = entry.path.endsWith(".md") || entry.path.endsWith(".txt") ? "doc" : "file";
		scored.push({
			path: entry.path,
			kind,
			score: dot,
			reason: `semantic similarity: ${dot.toFixed(3)}`,
		});
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k);
}
