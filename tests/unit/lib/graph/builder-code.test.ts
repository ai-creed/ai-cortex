import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import type { RepoStores } from "../../../../src/lib/graph/types.js";

const stores: RepoStores = {
	code: [
		{
			repoKey: "repoA",
			worktreePath: "/a",
			files: [
				{ path: "src/a.ts", kind: "source" },
				{ path: "src/b.ts", kind: "source" },
			],
			imports: [{ from: "src/a.ts", to: "src/b.ts" }],
			functions: [],
			calls: [],
		},
	],
	memories: [],
};

describe("buildGraph code mode", () => {
	it("scope=all emits one project node per code store", () => {
		const g = buildGraph(stores, { mode: "code", scope: "all" });
		expect(g.level).toBe("project");
		expect(g.nodes.map((n) => n.id)).toContain("project:repoA");
		expect(g.nodes.every((n) => n.kind === "project")).toBe(true);
	});

	it("scope=project flat emits file nodes and import edges, namespaced", () => {
		const g = buildGraph(stores, {
			mode: "code",
			scope: { project: "repoA" },
			flat: true,
		});
		expect(g.level).toBe("file");
		expect(g.nodes.map((n) => n.id).sort()).toEqual([
			"file:repoA:src/a.ts",
			"file:repoA:src/b.ts",
		]);
		expect(g.edges).toEqual([
			{
				source: "file:repoA:src/a.ts",
				target: "file:repoA:src/b.ts",
				rel: "imports",
			},
		]);
	});
});
