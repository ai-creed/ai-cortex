import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import type { RepoStores } from "../../../../src/lib/graph/types.js";

const stores: RepoStores = {
	code: [],
	memories: [
		{
			repoKey: "r",
			id: "m1",
			type: "decision",
			status: "active",
			title: "use sqlite",
			scopeFiles: ["src/db.ts"],
			scopeTags: ["storage"],
			links: [{ dstId: "m2", relType: "supports" }],
		},
		{
			repoKey: "r",
			id: "m2",
			type: "gotcha",
			status: "active",
			title: "wal mode",
			scopeFiles: [],
			scopeTags: ["storage"],
			links: [],
		},
	],
};

describe("memory mode", () => {
	it("emits namespaced memory nodes, link and scope edges", () => {
		const g = buildGraph(stores, { mode: "memory", scope: { project: "r" } });
		expect(g.nodes.map((n) => n.id).sort()).toEqual([
			"memory:r:m1",
			"memory:r:m2",
		]);
		const rels = g.edges.map((e) => `${e.rel}:${e.source}->${e.target}`);
		expect(rels).toContain("link:memory:r:m1->memory:r:m2");
		// shared "storage" tag => one scope edge between m1 and m2
		expect(g.edges.filter((e) => e.rel === "scope")).toHaveLength(1);
	});
});
