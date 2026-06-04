import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import type { RepoStores } from "../../../../src/lib/graph/types.js";

const stores: RepoStores = {
	code: [
		{
			repoKey: "r",
			worktreePath: "/r",
			files: [{ path: "src/db.ts", kind: "source" }],
			imports: [],
			functions: [],
			calls: [],
		},
	],
	memories: [
		{
			repoKey: "r",
			id: "m1",
			type: "decision",
			status: "active",
			title: "sqlite",
			scopeFiles: ["src/db.ts"],
			scopeTags: [],
			links: [],
		},
	],
};

describe("bridge mode", () => {
	it("anchors a memory to the file it scopes", () => {
		const g = buildGraph(stores, {
			mode: "bridge",
			scope: { project: "r" },
			flat: true,
		});
		const ids = g.nodes.map((n) => n.id);
		expect(ids).toContain("file:r:src/db.ts");
		expect(ids).toContain("memory:r:m1");
		expect(g.edges).toContainEqual({
			source: "memory:r:m1",
			target: "file:r:src/db.ts",
			rel: "anchor",
		});
	});
});
