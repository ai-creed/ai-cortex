// tests/unit/lib/models.test.ts
import { describe, expect, it } from "vitest";
import {
	EmbeddingInferenceError,
	IndexError,
	ModelLoadError,
	SCHEMA_VERSION,
	VectorIndexCorruptError,
} from "../../../src/lib/models.js";
import type { Range, CallEdge, FunctionNode } from "../../../src/lib/models.js";

describe("v3.1 model contract", () => {
	it("SCHEMA_VERSION is 3.1", () => {
		expect(SCHEMA_VERSION).toBe("3.1");
	});

	it("Range and the new optional fields are assignable", () => {
		const r: Range = { line: 1, column: 2, endLine: 3, endColumn: 4 };
		const edge: CallEdge = { from: "a::f", to: "b::g", kind: "call", site: r };
		const fn: FunctionNode = {
			qualifiedName: "f",
			file: "a",
			exported: true,
			isDefaultExport: false,
			line: 1,
			column: 2,
			endLine: 3,
			endColumn: 4,
		};
		expect(edge.site).toEqual(r);
		expect(fn.endColumn).toBe(4);
	});
});

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
