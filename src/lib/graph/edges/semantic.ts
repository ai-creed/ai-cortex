// src/lib/graph/edges/semantic.ts
import { dot } from "../cosine.js";
import { memoryNodeId } from "../types.js";
import type { BuildOpts, GraphEdge, MemoryRecord } from "../types.js";

const DEFAULT_TOPK = 2;
const DEFAULT_THRESHOLD = 0.65;

export function semanticEdges(
	mems: MemoryRecord[],
	opts: BuildOpts,
): GraphEdge[] {
	const topK = opts.semanticTopK ?? DEFAULT_TOPK;
	const threshold = opts.semanticThreshold ?? DEFAULT_THRESHOLD;
	const withVec = mems.filter((m) => m.vector && m.vector.length > 0);

	const seenPair = new Set<string>();
	const out: GraphEdge[] = [];
	for (let i = 0; i < withVec.length; i++) {
		const a = withVec[i]!;
		// Score against all others, keep the top-K above threshold for this node.
		const scored: { m: MemoryRecord; s: number }[] = [];
		for (let j = 0; j < withVec.length; j++) {
			if (j === i) continue;
			const b = withVec[j]!;
			if (a.vector!.length !== b.vector!.length) continue;
			const s = dot(a.vector!, b.vector!);
			if (s >= threshold) scored.push({ m: b, s });
		}
		scored.sort((x, y) => y.s - x.s);
		for (const { m: b, s } of scored.slice(0, topK)) {
			const idA = memoryNodeId(a.repoKey, a.id);
			const idB = memoryNodeId(b.repoKey, b.id);
			const pair = idA < idB ? `${idA} ${idB}` : `${idB} ${idA}`;
			if (seenPair.has(pair)) continue;
			seenPair.add(pair);
			out.push({ source: idA, target: idB, rel: "semantic", weight: s });
		}
	}
	return out;
}
