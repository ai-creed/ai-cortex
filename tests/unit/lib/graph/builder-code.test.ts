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
	it("scope=all (code) emits each project's directory structure", () => {
		const g = buildGraph(stores, { mode: "code", scope: "all" });
		expect(g.level).toBe("dir");
		expect(g.nodes.map((n) => n.id)).toContain("project:repoA");
		expect(g.nodes.some((n) => n.kind === "dir")).toBe(true);
	});

	it("resolves extensionless and /index imports to real files; drops externals", () => {
		const s: RepoStores = {
			code: [
				{
					repoKey: "r",
					worktreePath: "/r",
					files: [
						{ path: "src/a.ts", kind: "source" },
						{ path: "src/b.ts", kind: "source" },
						{ path: "src/c/index.ts", kind: "source" },
					],
					imports: [
						{ from: "src/a.ts", to: "src/b" }, // extensionless
						{ from: "src/a.ts", to: "src/c" }, // resolves to /index.ts
						{ from: "src/a.ts", to: "src/b" }, // duplicate -> deduped
						{ from: "src/a.ts", to: "react" }, // external -> dropped
					],
					functions: [],
					calls: [],
				},
			],
			memories: [],
		};
		const g = buildGraph(s, { mode: "code", scope: { project: "r" }, flat: true });
		const imp = g.edges
			.filter((e) => e.rel === "imports")
			.map((e) => `${e.source}->${e.target}`);
		expect(imp).toContain("file:r:src/a.ts->file:r:src/b.ts");
		expect(imp).toContain("file:r:src/a.ts->file:r:src/c/index.ts");
		expect(imp).toHaveLength(2);
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
