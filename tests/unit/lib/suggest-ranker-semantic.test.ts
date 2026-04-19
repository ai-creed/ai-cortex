// tests/unit/lib/suggest-ranker-semantic.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RepoCache } from "../../../src/lib/models.js";

vi.mock("../../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(),
}));

vi.mock("../../../src/lib/vector-sidecar.js", () => ({
	readVectorIndex: vi.fn(),
	writeVectorIndex: vi.fn(),
}));

vi.mock("../../../src/lib/vector-builder.js", () => ({
	getSidecarDir: vi.fn().mockReturnValue("/tmp/sidecar"),
	buildVectorIndex: vi.fn(),
	refreshVectorIndex: vi.fn(),
}));

function makeCache(filePaths: string[]): RepoCache {
	return {
		schemaVersion: "3",
		repoKey: "test-repo",
		worktreeKey: "test-worktree",
		worktreePath: "/tmp/test-repo",
		indexedAt: new Date().toISOString(),
		fingerprint: "fp",
		packageMeta: { name: "test", version: "1.0.0", framework: null },
		entryFiles: [],
		files: filePaths.map((p) => ({ path: p, kind: "file" as const, contentHash: "h" })),
		docs: [],
		imports: [],
		calls: [],
		functions: [],
	};
}

function makeIndex(paths: string[], dim: number = 384) {
	const entries = paths.map((p) => ({ path: p, hash: "h" }));
	// L2-normalized vectors with decreasing similarity to query [1, 0, 0, ...]
	// Row i uses angle = i*π/(2*n) so cos(angle) decreases with i (cos²+sin²=1 → unit norm)
	const matrix = new Float32Array(paths.length * dim);
	const n = Math.max(paths.length, 1);
	for (let i = 0; i < paths.length; i++) {
		const angle = (i * Math.PI) / (2 * n);
		matrix[i * dim] = Math.cos(angle);
		if (dim > 1) matrix[i * dim + 1] = Math.sin(angle);
	}
	return {
		meta: { modelName: "Xenova/all-MiniLM-L6-v2", dim, count: paths.length, entries },
		matrix,
	};
}

describe("rankSuggestionsSemanticCore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns ranked results when sidecar exists", async () => {
		const { readVectorIndex } = await import("../../../src/lib/vector-sidecar.js");
		const { getProvider } = await import("../../../src/lib/embed-provider.js");

		const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const index = makeIndex(paths);
		(readVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(index);

		// Query vector aligned with first file's vector
		const queryVec = new Float32Array(384).fill(0);
		queryVec[0] = 1.0;
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: vi.fn().mockResolvedValue([queryVec]),
		});

		const { rankSuggestionsSemanticCore } = await import(
			"../../../src/lib/suggest-ranker-semantic.js",
		);
		const cache = makeCache(paths);
		const result = await rankSuggestionsSemanticCore("find something", cache, "/tmp/test-repo");

		expect(result.results).toHaveLength(3);
		expect(result.results[0]!.path).toBe("src/a.ts"); // highest similarity
		expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score);
		expect(result.poolSize).toBe(3);
	});

	it("builds sidecar when none exists", async () => {
		const { readVectorIndex } = await import("../../../src/lib/vector-sidecar.js");
		const { buildVectorIndex } = await import("../../../src/lib/vector-builder.js");
		const { getProvider } = await import("../../../src/lib/embed-provider.js");

		const paths = ["src/a.ts"];
		const index = makeIndex(paths);
		(readVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(null);
		(buildVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index);

		const queryVec = new Float32Array(384).fill(0);
		queryVec[0] = 1.0;
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: vi.fn().mockResolvedValue([queryVec]),
		});

		const { rankSuggestionsSemanticCore } = await import(
			"../../../src/lib/suggest-ranker-semantic.js",
		);
		const cache = makeCache(paths);
		await rankSuggestionsSemanticCore("find something", cache, "/tmp/test-repo");

		expect(buildVectorIndex).toHaveBeenCalledWith("/tmp/test-repo", cache);
	});

	it("refreshes sidecar when stale=true", async () => {
		const { readVectorIndex } = await import("../../../src/lib/vector-sidecar.js");
		const { refreshVectorIndex } = await import("../../../src/lib/vector-builder.js");
		const { getProvider } = await import("../../../src/lib/embed-provider.js");

		const paths = ["src/a.ts"];
		const index = makeIndex(paths);
		(readVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(index);
		(refreshVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index);

		const queryVec = new Float32Array(384).fill(0);
		queryVec[0] = 1.0;
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: vi.fn().mockResolvedValue([queryVec]),
		});

		const { rankSuggestionsSemanticCore } = await import(
			"../../../src/lib/suggest-ranker-semantic.js",
		);
		const cache = makeCache(paths);
		await rankSuggestionsSemanticCore("find something", cache, "/tmp/test-repo", {
			stale: true,
		});

		expect(refreshVectorIndex).toHaveBeenCalledWith("/tmp/test-repo", cache, index);
	});

	it("limits results to options.limit", async () => {
		const { readVectorIndex } = await import("../../../src/lib/vector-sidecar.js");
		const { getProvider } = await import("../../../src/lib/embed-provider.js");

		const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
		const index = makeIndex(paths);
		(readVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(index);

		const queryVec = new Float32Array(384).fill(0);
		queryVec[0] = 1.0;
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: vi.fn().mockResolvedValue([queryVec]),
		});

		const { rankSuggestionsSemanticCore } = await import(
			"../../../src/lib/suggest-ranker-semantic.js",
		);
		const cache = makeCache(paths);
		const result = await rankSuggestionsSemanticCore("find something", cache, "/tmp/test-repo", {
			limit: 2,
		});

		expect(result.results).toHaveLength(2);
	});

	it("returns empty results for empty index (zero-file repo)", async () => {
		const { readVectorIndex } = await import("../../../src/lib/vector-sidecar.js");
		const { getProvider } = await import("../../../src/lib/embed-provider.js");

		const index = makeIndex([]);
		(readVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(index);

		const queryVec = new Float32Array(384).fill(0);
		queryVec[0] = 1.0;
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: vi.fn().mockResolvedValue([queryVec]),
		});

		const { rankSuggestionsSemanticCore } = await import(
			"../../../src/lib/suggest-ranker-semantic.js",
		);
		const cache = makeCache([]);
		const result = await rankSuggestionsSemanticCore("find something", cache, "/tmp/test-repo");

		expect(result.results).toHaveLength(0);
		expect(result.poolSize).toBe(0);
	});

	it("classifies .md files as doc kind", async () => {
		const { readVectorIndex } = await import("../../../src/lib/vector-sidecar.js");
		const { getProvider } = await import("../../../src/lib/embed-provider.js");

		const paths = ["README.md", "src/a.ts"];
		const index = makeIndex(paths);
		(readVectorIndex as ReturnType<typeof vi.fn>).mockReturnValue(index);

		const queryVec = new Float32Array(384).fill(0);
		queryVec[0] = 1.0;
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: vi.fn().mockResolvedValue([queryVec]),
		});

		const { rankSuggestionsSemanticCore } = await import(
			"../../../src/lib/suggest-ranker-semantic.js",
		);
		const cache = makeCache(paths);
		const result = await rankSuggestionsSemanticCore("find something", cache, "/tmp/test-repo");

		const mdResult = result.results.find((r) => r.path === "README.md");
		expect(mdResult?.kind).toBe("doc");
		const tsResult = result.results.find((r) => r.path === "src/a.ts");
		expect(tsResult?.kind).toBe("file");
	});
});
