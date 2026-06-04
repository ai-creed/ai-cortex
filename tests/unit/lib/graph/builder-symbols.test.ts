import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import type { RepoStores } from "../../../../src/lib/graph/types.js";

const stores: RepoStores = {
	code: [
		{
			repoKey: "r",
			worktreePath: "/r",
			files: [{ path: "src/a.ts", kind: "source" }],
			imports: [],
			functions: [
				{ qualifiedName: "foo", file: "src/a.ts", exported: true, line: 1 },
				{ qualifiedName: "bar", file: "src/a.ts", exported: false, line: 9 },
			],
			calls: [
				{ from: "src/a.ts::foo", to: "src/a.ts::bar", kind: "call" },
				{ from: "src/a.ts::foo", to: "::unknownExternal", kind: "call" },
			],
		},
	],
	memories: [],
};

describe("symbol focus", () => {
	it("emits symbol nodes and resolved call edges for the focused file", () => {
		const g = buildGraph(stores, {
			mode: "code",
			scope: { project: "r" },
			focus: "file:r:src/a.ts",
		});
		expect(g.level).toBe("symbol");
		expect(g.nodes.map((n) => n.id).sort()).toEqual([
			"symbol:r:src/a.ts::bar",
			"symbol:r:src/a.ts::foo",
		]);
		expect(g.edges).toEqual([
			{
				source: "symbol:r:src/a.ts::foo",
				target: "symbol:r:src/a.ts::bar",
				rel: "calls",
				meta: { kind: "call" },
			},
		]);
	});
});
