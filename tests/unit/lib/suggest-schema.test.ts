import { describe, expect, it } from "vitest";
import {
	DeepSuggestResultSchema,
	FastSuggestResultSchema,
	SemanticSuggestResultSchema,
} from "../../../src/lib/suggest.js";

const baseDeep = {
	mode: "deep" as const,
	cacheStatus: "fresh" as const,
	durationMs: 12,
	task: "x",
	from: null,
	results: [],
	poolSize: 60,
};

describe("Result schemas — relatedMemories field", () => {
	it("validates without relatedMemories (omitted)", () => {
		expect(() => DeepSuggestResultSchema.parse(baseDeep)).not.toThrow();
	});

	it("validates with relatedMemories present", () => {
		const withMem = {
			...baseDeep,
			relatedMemories: [
				{
					id: "mem-abc",
					title: "rule",
					track: "scoped" as const,
					scope: { files: ["src/**"], tags: [] },
					matchScores: { task: 0.78, fileOverlap: ["src/foo.ts"] },
				},
			],
		};
		expect(() => DeepSuggestResultSchema.parse(withMem)).not.toThrow();
	});

	it("rejects invalid track value", () => {
		const bad = {
			...baseDeep,
			relatedMemories: [
				{
					id: "mem-abc",
					title: "rule",
					track: "bogus",
					scope: { files: [], tags: [] },
					matchScores: { task: 0.5, fileOverlap: [] },
				},
			],
		};
		expect(() => DeepSuggestResultSchema.parse(bad)).toThrow();
	});

	it("Fast schema also accepts relatedMemories", () => {
		const fast = {
			mode: "fast" as const,
			cacheStatus: "fresh" as const,
			durationMs: 2,
			task: "x",
			from: null,
			results: [],
			relatedMemories: [],
		};
		expect(() => FastSuggestResultSchema.parse(fast)).not.toThrow();
	});

	it("Semantic schema also accepts relatedMemories", () => {
		const sem = {
			mode: "semantic" as const,
			cacheStatus: "fresh" as const,
			durationMs: 5,
			task: "x",
			from: null,
			results: [],
			poolSize: 7000,
			relatedMemories: [],
		};
		expect(() => SemanticSuggestResultSchema.parse(sem)).not.toThrow();
	});
});
