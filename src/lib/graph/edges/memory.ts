// src/lib/graph/edges/memory.ts
import { memoryNodeId } from "../types.js";
import type { GraphEdge, GraphNode, MemoryRecord } from "../types.js";

export function memoryNodes(mems: MemoryRecord[]): GraphNode[] {
	return mems.map((m) => ({
		id: memoryNodeId(m.repoKey, m.id),
		kind: "memory" as const,
		label: m.title,
		cluster: m.repoKey,
		meta: {
			type: m.type,
			status: m.status,
			confidence: m.confidence,
			getCount: m.getCount,
			pinned: m.pinned,
		},
	}));
}

export function linkEdges(mems: MemoryRecord[]): GraphEdge[] {
	const present = new Set(mems.map((m) => `${m.repoKey} ${m.id}`));
	const out: GraphEdge[] = [];
	for (const m of mems) {
		for (const l of m.links) {
			// Explicit links are within a store; only emit if the target exists.
			if (!present.has(`${m.repoKey} ${l.dstId}`)) continue;
			out.push({
				source: memoryNodeId(m.repoKey, m.id),
				target: memoryNodeId(m.repoKey, l.dstId),
				rel: "link",
				meta: { relType: l.relType },
			});
		}
	}
	return out;
}

// Undirected scope edges: memories sharing a tag or file (same store) connect.
// Deduplicated; one edge per unordered pair regardless of how many keys overlap.
export function scopeEdges(mems: MemoryRecord[]): GraphEdge[] {
	const byKey = new Map<string, MemoryRecord[]>();
	for (const m of mems) {
		for (const t of m.scopeTags) push(byKey, `${m.repoKey} tag ${t}`, m);
		for (const f of m.scopeFiles) push(byKey, `${m.repoKey} file ${f}`, m);
	}
	const seenPair = new Set<string>();
	const out: GraphEdge[] = [];
	for (const group of byKey.values()) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = memoryNodeId(group[i]!.repoKey, group[i]!.id);
				const b = memoryNodeId(group[j]!.repoKey, group[j]!.id);
				const pair = a < b ? `${a} ${b}` : `${b} ${a}`;
				if (seenPair.has(pair)) continue;
				seenPair.add(pair);
				out.push({ source: a, target: b, rel: "scope" });
			}
		}
	}
	return out;
}

function push(m: Map<string, MemoryRecord[]>, k: string, v: MemoryRecord): void {
	const arr = m.get(k);
	if (arr) arr.push(v);
	else m.set(k, [v]);
}
