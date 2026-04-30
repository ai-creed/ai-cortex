// tests/unit/lib/suggest-semantic-type.test.ts
import { describe, expect, it } from "vitest";
import { SemanticSuggestResultSchema } from "../../../src/lib/suggest.js";

describe("SemanticSuggestResultSchema", () => {
	it("validates a well-formed SemanticSuggestResult", () => {
		const input = {
			mode: "semantic",
			cacheStatus: "fresh",
			task: "find auth middleware",
			from: null,
			durationMs: 42,
			poolSize: 10,
			results: [
				{
					path: "src/auth.ts",
					kind: "file",
					score: 0.92,
					reason: "semantic similarity: 0.920",
				},
				{
					path: "docs/auth.md",
					kind: "doc",
					score: 0.75,
					reason: "semantic similarity: 0.750",
				},
			],
		};
		const result = SemanticSuggestResultSchema.safeParse(input);
		expect(result.success).toBe(true);
	});

	it("rejects missing poolSize", () => {
		const input = {
			mode: "semantic",
			cacheStatus: "fresh",
			task: "find auth",
			from: null,
			durationMs: 10,
			results: [],
		};
		const result = SemanticSuggestResultSchema.safeParse(input);
		expect(result.success).toBe(false);
	});

	it("rejects wrong mode", () => {
		const input = {
			mode: "deep",
			cacheStatus: "fresh",
			task: "find auth",
			from: null,
			durationMs: 10,
			poolSize: 5,
			results: [],
		};
		const result = SemanticSuggestResultSchema.safeParse(input);
		expect(result.success).toBe(false);
	});

	it("rejects invalid kind in results", () => {
		const input = {
			mode: "semantic",
			cacheStatus: "fresh",
			task: "find auth",
			from: null,
			durationMs: 10,
			poolSize: 1,
			results: [
				{ path: "src/a.ts", kind: "dir", score: 0.5, reason: "x" }, // invalid kind
			],
		};
		const result = SemanticSuggestResultSchema.safeParse(input);
		expect(result.success).toBe(false);
	});
});
