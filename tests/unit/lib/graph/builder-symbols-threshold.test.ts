import { describe, it, expect } from "vitest";
import { buildGraph } from "../../../../src/lib/graph/builder.js";
import {
	CODE_SYMBOL_NODE_THRESHOLD,
	type CodeStore,
	type RepoStores,
} from "../../../../src/lib/graph/types.js";

function smallStore(): CodeStore {
	return {
		repoKey: "r",
		worktreePath: "/r",
		files: [{ path: "src/a.ts", kind: "source" }],
		imports: [],
		functions: [
			{ qualifiedName: "foo", file: "src/a.ts", exported: true, line: 1 },
			{ qualifiedName: "bar", file: "src/a.ts", exported: false, line: 9 },
		],
		calls: [{ from: "src/a.ts::foo", to: "src/a.ts::bar", kind: "call" }],
	};
}

// One function per file, so files + functions = 2 * fileCount.
function bigStore(fileCount: number): CodeStore {
	const files = [];
	const functions = [];
	for (let i = 0; i < fileCount; i++) {
		const path = `src/f${i}.ts`;
		files.push({ path, kind: "source" });
		functions.push({ qualifiedName: "main", file: path, exported: false, line: 1 });
	}
	return { repoKey: "r", worktreePath: "/r", files, imports: [], functions, calls: [] };
}

const stores = (s: CodeStore): RepoStores => ({ code: [s], memories: [] });

describe("single-project code brain: function-node gating", () => {
	it("auto-includes functions when under the threshold", () => {
		const g = buildGraph(stores(smallStore()), {
			mode: "code",
			scope: { project: "r" },
			full: true,
		});
		expect(g.symbolsIncluded).toBe(true);
		expect(g.symbolCount).toBe(2);
		expect(g.level).toBe("symbol");
		expect(g.nodes.some((n) => n.kind === "symbol")).toBe(true);
	});

	it("auto-hides functions when total nodes exceed the threshold", () => {
		const fileCount = CODE_SYMBOL_NODE_THRESHOLD; // 2 * fileCount > threshold
		const g = buildGraph(stores(bigStore(fileCount)), {
			mode: "code",
			scope: { project: "r" },
			full: true,
		});
		expect(g.symbolsIncluded).toBe(false);
		expect(g.symbolCount).toBe(fileCount);
		expect(g.level).toBe("file");
		expect(g.nodes).toHaveLength(fileCount); // files only
		expect(g.nodes.some((n) => n.kind === "symbol")).toBe(false);
	});

	it("symbols:false forces functions off even on a small graph", () => {
		const g = buildGraph(stores(smallStore()), {
			mode: "code",
			scope: { project: "r" },
			full: true,
			symbols: false,
		});
		expect(g.symbolsIncluded).toBe(false);
		expect(g.symbolCount).toBe(2);
		expect(g.nodes.some((n) => n.kind === "symbol")).toBe(false);
	});

	it("symbols:true forces functions on even past the threshold", () => {
		const fileCount = CODE_SYMBOL_NODE_THRESHOLD;
		const g = buildGraph(stores(bigStore(fileCount)), {
			mode: "code",
			scope: { project: "r" },
			full: true,
			symbols: true,
		});
		expect(g.symbolsIncluded).toBe(true);
		expect(g.nodes).toHaveLength(fileCount * 2); // files + functions
		expect(g.nodes.some((n) => n.kind === "symbol")).toBe(true);
	});
});
