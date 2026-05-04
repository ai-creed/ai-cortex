// tests/unit/lib/vector-builder.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoCache } from "../../../src/lib/models.js";
import { EMBEDDING_DIM, MODEL_NAME } from "../../../src/lib/embed-provider.js";
import type { VectorIndex } from "../../../src/lib/vector-sidecar.js";

// Mock the embed provider so we don't download ~23MB
vi.mock("../../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(),
}));

// Mock writeVectorIndex so we don't write to disk
vi.mock("../../../src/lib/vector-sidecar.js", () => ({
	writeVectorIndex: vi.fn(),
	readVectorIndex: vi.fn(),
}));

function makeCache(files: { path: string; hash?: string }[]): RepoCache {
	return {
		schemaVersion: "3",
		repoKey: "test-repo",
		worktreeKey: "abcdef1234567890",
		worktreePath: "/tmp/test-repo",
		indexedAt: new Date().toISOString(),
		fingerprint: "fp",
		packageMeta: {
			name: "test",
			version: "1.0.0",
			framework: null,
		},
		entryFiles: [],
		files: files.map((f) => ({
			path: f.path,
			kind: "file" as const,
			contentHash: f.hash,
		})),
		docs: [],
		imports: [],
		calls: [],
		functions: [],
	};
}

function makeEmbedder(dim: number = EMBEDDING_DIM) {
	let counter = 0;
	return vi.fn().mockImplementation(async (texts: string[]) => {
		return texts.map(() => {
			const vec = new Float32Array(dim).fill(0);
			vec[0] = ++counter * 0.1;
			return vec;
		});
	});
}

describe("buildVectorIndex", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("embeds all file-kind entries and returns a VectorIndex", async () => {
		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const embedFn = makeEmbedder();
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: embedFn,
		});

		const { buildVectorIndex } =
			await import("../../../src/lib/vector-builder.js");
		const cache = makeCache([
			{ path: "src/a.ts", hash: "h1" },
			{ path: "src/b.ts", hash: "h2" },
		]);

		const index = await buildVectorIndex("/tmp/test-repo", cache);

		expect(index.meta.modelName).toBe(MODEL_NAME);
		expect(index.meta.dim).toBe(EMBEDDING_DIM);
		expect(index.meta.count).toBe(2);
		expect(index.meta.entries).toEqual([
			{ path: "src/a.ts", hash: "h1" },
			{ path: "src/b.ts", hash: "h2" },
		]);
		expect(index.matrix).toBeInstanceOf(Float32Array);
		expect(index.matrix.length).toBe(2 * EMBEDDING_DIM);
		expect(embedFn).toHaveBeenCalledTimes(2); // once per file
	});

	it("skips dir-kind entries", async () => {
		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const embedFn = makeEmbedder();
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: embedFn,
		});

		const { buildVectorIndex } =
			await import("../../../src/lib/vector-builder.js");
		const cache: RepoCache = {
			...makeCache([{ path: "src/a.ts", hash: "h1" }]),
			files: [
				{ path: "src", kind: "dir" as const },
				{ path: "src/a.ts", kind: "file" as const, contentHash: "h1" },
			],
		};

		const index = await buildVectorIndex("/tmp/test-repo", cache);
		expect(index.meta.count).toBe(1);
	});

	it("uses contentHash as entry hash, empty string when undefined", async () => {
		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const embedFn = makeEmbedder();
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: embedFn,
		});

		const { buildVectorIndex } =
			await import("../../../src/lib/vector-builder.js");
		const cache = makeCache([{ path: "src/a.ts" }]); // no hash

		const index = await buildVectorIndex("/tmp/test-repo", cache);
		expect(index.meta.entries[0]!.hash).toBe("");
	});
});

describe("refreshVectorIndex", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reuses existing vectors for unchanged files (same hash)", async () => {
		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const embedFn = makeEmbedder();
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: embedFn,
		});

		const { refreshVectorIndex } =
			await import("../../../src/lib/vector-builder.js");

		const existingMatrix = new Float32Array(2 * EMBEDDING_DIM).fill(0.5);
		const existing: VectorIndex = {
			meta: {
				modelName: MODEL_NAME,
				dim: EMBEDDING_DIM,
				count: 2,
				entries: [
					{ path: "src/a.ts", hash: "h1" },
					{ path: "src/b.ts", hash: "h2" },
				],
			},
			matrix: existingMatrix,
		};
		const cache = makeCache([
			{ path: "src/a.ts", hash: "h1" }, // unchanged
			{ path: "src/b.ts", hash: "h2" }, // unchanged
		]);

		const index = await refreshVectorIndex("/tmp/test-repo", cache, existing);

		expect(embedFn).not.toHaveBeenCalled(); // no re-embedding needed
		expect(index.meta.count).toBe(2);
		// Matrix values should match existing
		expect(index.matrix[0]).toBeCloseTo(0.5, 5);
	});

	it("re-embeds modified files (hash changed)", async () => {
		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const embedFn = makeEmbedder();
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: embedFn,
		});

		const { refreshVectorIndex } =
			await import("../../../src/lib/vector-builder.js");

		const existingMatrix = new Float32Array(EMBEDDING_DIM).fill(0.5);
		const existing: VectorIndex = {
			meta: {
				modelName: MODEL_NAME,
				dim: EMBEDDING_DIM,
				count: 1,
				entries: [{ path: "src/a.ts", hash: "old-hash" }],
			},
			matrix: existingMatrix,
		};
		const cache = makeCache([
			{ path: "src/a.ts", hash: "new-hash" }, // modified
		]);

		const index = await refreshVectorIndex("/tmp/test-repo", cache, existing);

		expect(embedFn).toHaveBeenCalledOnce(); // re-embedded
		expect(index.meta.entries[0]!.hash).toBe("new-hash");
	});

	it("embeds new files not in existing index", async () => {
		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const embedFn = makeEmbedder();
		(getProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
			embed: embedFn,
		});

		const { refreshVectorIndex } =
			await import("../../../src/lib/vector-builder.js");

		const existing: VectorIndex = {
			meta: {
				modelName: MODEL_NAME,
				dim: EMBEDDING_DIM,
				count: 0,
				entries: [],
			},
			matrix: new Float32Array(0),
		};
		const cache = makeCache([{ path: "src/new.ts", hash: "h-new" }]);

		const index = await refreshVectorIndex("/tmp/test-repo", cache, existing);

		expect(embedFn).toHaveBeenCalledOnce();
		expect(index.meta.count).toBe(1);
		expect(index.meta.entries[0]!.path).toBe("src/new.ts");
	});
});
