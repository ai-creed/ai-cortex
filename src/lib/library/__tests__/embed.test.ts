// src/lib/library/__tests__/embed.test.ts
import { describe, expect, it, vi } from "vitest";

// Mock the shared provider so the test never downloads a model.
vi.mock("../../embed-provider.js", () => ({
	getPooledProvider: vi.fn(async (_modelName: string) => ({
		embed: async (texts: string[]) =>
			texts.map(() => {
				const v = new Float32Array([0.6, 0.8, 0, 0, 0, 0]); // already L2-normalized, dim 6
				return v;
			}),
	})),
}));

import { getLibraryEmbedder, LIBRARY_EMBED_MODEL } from "../embed.js";
import { getPooledProvider } from "../../embed-provider.js";

describe("getLibraryEmbedder", () => {
	it("builds an Embedder, probing dim and recording modelId", async () => {
		const e = await getLibraryEmbedder();
		expect(e.modelId).toBe(LIBRARY_EMBED_MODEL);
		expect(e.dim).toBe(6);
		const [vec] = await e.embed(["hello"]);
		expect(vec.length).toBe(6);
		expect(getPooledProvider).toHaveBeenCalledWith(LIBRARY_EMBED_MODEL);
	});
});
