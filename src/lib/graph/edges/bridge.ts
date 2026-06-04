// src/lib/graph/edges/bridge.ts
import { fileId, memoryNodeId } from "../types.js";
import type { CodeStore, GraphEdge, MemoryRecord } from "../types.js";

// A memory's scope.files point into its own repo, so both endpoints share the
// memory's repoKey. Emit anchors only to files that exist as nodes.
export function anchorEdges(
	store: CodeStore,
	mems: MemoryRecord[],
): GraphEdge[] {
	const known = new Set(store.files.map((f) => f.path));
	const out: GraphEdge[] = [];
	for (const m of mems) {
		if (m.repoKey !== store.repoKey) continue;
		for (const f of m.scopeFiles) {
			if (!known.has(f)) continue;
			out.push({
				source: memoryNodeId(m.repoKey, m.id),
				target: fileId(store.repoKey, f),
				rel: "anchor",
			});
		}
	}
	return out;
}
