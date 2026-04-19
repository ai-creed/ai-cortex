// tests/unit/lib/embed-provider.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelLoadError, EmbeddingInferenceError } from "../../../src/lib/models.js";
import { EMBEDDING_DIM, MODEL_NAME } from "../../../src/lib/embed-provider.js";

// We mock @xenova/transformers so we don't download ~23MB during unit tests
vi.mock("@xenova/transformers", () => {
	const mockPipeline = vi.fn();
	return {
		pipeline: mockPipeline,
		env: { allowLocalModels: true, useBrowserCache: false },
	};
});

describe("embed-provider", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exports MODEL_NAME and EMBEDDING_DIM constants", () => {
		expect(MODEL_NAME).toBe("Xenova/all-MiniLM-L6-v2");
		expect(EMBEDDING_DIM).toBe(384);
	});

	it("getProvider returns an object with embed function", async () => {
		const { pipeline } = await import("@xenova/transformers");
		const mockEmbed = vi.fn().mockResolvedValue({
			data: new Float32Array(384).fill(0.1),
			dims: [1, 384],
		});
		(pipeline as ReturnType<typeof vi.fn>).mockResolvedValue(mockEmbed);

		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const provider = await getProvider();
		expect(provider).toHaveProperty("embed");
		expect(typeof provider.embed).toBe("function");
	});

	it("embed returns L2-normalized Float32Array for each input", async () => {
		const { pipeline } = await import("@xenova/transformers");
		// Raw vector: [3, 4] (norm = 5), normalized = [0.6, 0.8] + 382 zeros
		const rawVec = new Float32Array(384).fill(0);
		rawVec[0] = 3;
		rawVec[1] = 4;
		const mockEmbed = vi.fn().mockResolvedValue({
			data: rawVec,
			dims: [1, 384],
		});
		(pipeline as ReturnType<typeof vi.fn>).mockResolvedValue(mockEmbed);

		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const provider = await getProvider();
		const results = await provider.embed(["hello world"]);

		expect(results).toHaveLength(1);
		expect(results[0]).toBeInstanceOf(Float32Array);
		expect(results[0]!.length).toBe(384);
		// Check L2-normalized values: [3,4] / 5 = [0.6, 0.8]
		expect(results[0]![0]).toBeCloseTo(0.6, 5);
		expect(results[0]![1]).toBeCloseTo(0.8, 5);
	});

	it("wraps pipeline load failure in ModelLoadError", async () => {
		const { pipeline } = await import("@xenova/transformers");
		(pipeline as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("model not found"));

		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const { ModelLoadError: FreshModelLoadError } = await import("../../../src/lib/models.js");
		await expect(getProvider()).rejects.toThrow(FreshModelLoadError);
	});

	it("wraps inference failure in EmbeddingInferenceError", async () => {
		const { pipeline } = await import("@xenova/transformers");
		const mockEmbed = vi.fn().mockRejectedValue(new Error("ONNX runtime failed"));
		(pipeline as ReturnType<typeof vi.fn>).mockResolvedValue(mockEmbed);

		const { getProvider } = await import("../../../src/lib/embed-provider.js");
		const { EmbeddingInferenceError: FreshEmbeddingInferenceError } = await import("../../../src/lib/models.js");
		const provider = await getProvider();
		await expect(provider.embed(["test"])).rejects.toThrow(FreshEmbeddingInferenceError);
	});
});
