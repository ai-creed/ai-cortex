import { describe, it, expect } from "vitest";
import { semanticEdges } from "../../../../src/lib/graph/edges/semantic.js";
import type { MemoryRecord } from "../../../../src/lib/graph/types.js";

function mem(id: string, vec: number[]): MemoryRecord {
	return {
		repoKey: "r",
		id,
		type: "decision",
		status: "active",
		title: id,
		scopeFiles: [],
		scopeTags: [],
		links: [],
		vector: Float32Array.from(vec),
	};
}

describe("semanticEdges", () => {
	it("links near vectors above threshold, skips far ones, dedups pairs", () => {
		const mems = [
			mem("a", [1, 0]),
			mem("b", [0.99, 0.141]), // cosine ~0.99 with a
			mem("c", [0, 1]), // orthogonal to a
		];
		const edges = semanticEdges(mems, {
			mode: "memory",
			scope: "all",
			semantic: true,
			semanticThreshold: 0.55,
			semanticTopK: 4,
		});
		const pairs = edges.map((e) => [e.source, e.target].sort().join("|"));
		expect(pairs).toContain("memory:r:a|memory:r:b");
		expect(pairs).not.toContain("memory:r:a|memory:r:c");
		// undirected dedup: a-b appears once, not twice
		expect(pairs.filter((p) => p === "memory:r:a|memory:r:b")).toHaveLength(1);
		expect(
			edges.every((e) => e.rel === "semantic" && typeof e.weight === "number"),
		).toBe(true);
	});

	it("skips memories without vectors", () => {
		const a = mem("a", [1, 0]);
		const b: MemoryRecord = { ...mem("b", [1, 0]) };
		delete b.vector;
		expect(
			semanticEdges([a, b], { mode: "memory", scope: "all", semantic: true }),
		).toHaveLength(0);
	});
});
