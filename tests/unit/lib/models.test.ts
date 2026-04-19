// tests/unit/lib/models.test.ts
import { describe, expect, it } from "vitest";
import {
	EmbeddingInferenceError,
	IndexError,
	ModelLoadError,
	VectorIndexCorruptError,
} from "../../../src/lib/models.js";

describe("semantic error classes", () => {
	it("ModelLoadError has correct name", () => {
		const e = new ModelLoadError("test");
		expect(e.name).toBe("ModelLoadError");
		expect(e.message).toBe("test");
		expect(e).toBeInstanceOf(Error);
	});

	it("VectorIndexCorruptError has correct name", () => {
		const e = new VectorIndexCorruptError("bad sidecar");
		expect(e.name).toBe("VectorIndexCorruptError");
		expect(e.message).toBe("bad sidecar");
		expect(e).toBeInstanceOf(Error);
	});

	it("EmbeddingInferenceError has correct name", () => {
		const e = new EmbeddingInferenceError("fail");
		expect(e.name).toBe("EmbeddingInferenceError");
		expect(e.message).toBe("fail");
		expect(e).toBeInstanceOf(Error);
	});

	it("existing IndexError still follows same pattern", () => {
		const e = new IndexError("existing");
		expect(e.name).toBe("IndexError");
		expect(e.message).toBe("existing");
		expect(e).toBeInstanceOf(Error);
	});
});
