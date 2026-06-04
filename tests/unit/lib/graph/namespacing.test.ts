import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import type { RepoStores } from "../../../../src/lib/graph/types.js";

// Two stores hold a memory with the SAME raw id "dup". The all-projects graph
// must keep them distinct and must not cross-attach scope edges.
const stores: RepoStores = {
	code: [],
	memories: [
		{
			repoKey: "repoA",
			id: "dup",
			type: "decision",
			status: "active",
			title: "A",
			scopeFiles: [],
			scopeTags: ["x"],
			links: [],
		},
		{
			repoKey: "repoB",
			id: "dup",
			type: "decision",
			status: "active",
			title: "B",
			scopeFiles: [],
			scopeTags: ["x"],
			links: [],
		},
	],
};

describe("cross-store node id namespacing", () => {
	it("keeps same-raw-id memories distinct and does not cross-link by scope", () => {
		const g = buildGraph(stores, { mode: "memory", scope: "all" });
		const ids = g.nodes.map((n) => n.id).sort();
		expect(ids).toEqual(["memory:repoA:dup", "memory:repoB:dup"]);
		// shared tag "x" is in DIFFERENT stores => no scope edge across stores
		expect(g.edges.filter((e) => e.rel === "scope")).toHaveLength(0);
	});
});
