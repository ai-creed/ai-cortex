import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import type { CodeStore, RepoStores } from "../../../../src/lib/graph/types.js";

function bigStore(n: number): CodeStore {
	const files = [];
	for (let i = 0; i < n; i++) {
		const top = `pkg${i % 50}`;
		files.push({ path: `${top}/file${i}.ts`, kind: "source" });
	}
	return {
		repoKey: "big",
		worktreePath: "/big",
		files,
		imports: [],
		functions: [],
		calls: [],
	};
}

describe("adaptive detail", () => {
	it("rolls a 10k-file project up to bounded dir super-nodes by default", () => {
		const stores: RepoStores = { code: [bigStore(10000)], memories: [] };
		const g = buildGraph(stores, { mode: "code", scope: { project: "big" } });
		expect(g.level).toBe("dir");
		// 50 top-level dirs => at most ~51 nodes (dirs + project), never 10000.
		expect(g.nodes.length).toBeLessThan(60);
		expect(g.nodes.some((n) => n.kind === "dir")).toBe(true);
	});

	it("flat bypass emits all file nodes", () => {
		const stores: RepoStores = { code: [bigStore(10000)], memories: [] };
		const g = buildGraph(stores, {
			mode: "code",
			scope: { project: "big" },
			flat: true,
		});
		expect(g.level).toBe("file");
		expect(g.nodes.filter((n) => n.kind === "file")).toHaveLength(10000);
	});

	it("dir focus reveals only that directory's files and intra-dir imports", () => {
		const store: CodeStore = {
			repoKey: "r",
			worktreePath: "/r",
			files: [
				{ path: "src/a.ts", kind: "source" },
				{ path: "src/b.ts", kind: "source" },
				{ path: "lib/c.ts", kind: "source" },
			],
			imports: [
				{ from: "src/a.ts", to: "src/b.ts" }, // intra-dir: kept
				{ from: "src/a.ts", to: "lib/c.ts" }, // crosses out of src: dropped
			],
			functions: [],
			calls: [],
		};
		const g = buildGraph(
			{ code: [store], memories: [] },
			{ mode: "code", scope: { project: "r" }, focus: "dir:r:src" },
		);
		expect(g.level).toBe("file");
		expect(g.nodes.map((n) => n.id).sort()).toEqual([
			"file:r:src/a.ts",
			"file:r:src/b.ts",
		]);
		expect(g.edges).toEqual([
			{ source: "file:r:src/a.ts", target: "file:r:src/b.ts", rel: "imports" },
		]);
	});
});
