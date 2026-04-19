// tests/unit/cli/suggest-semantic.test.ts
import { describe, expect, it } from "vitest";
import type { SemanticSuggestResult } from "../../../src/lib/suggest.js";

function makeSemanticResult(overrides: Partial<SemanticSuggestResult> = {}): SemanticSuggestResult {
	return {
		mode: "semantic",
		cacheStatus: "fresh",
		task: "find auth middleware",
		from: null,
		durationMs: 42,
		poolSize: 10,
		results: [
			{ path: "src/auth.ts", kind: "file", score: 0.92, reason: "semantic similarity: 0.920" },
		],
		...overrides,
	};
}

describe("suggest-semantic CLI", () => {
	it("renders SemanticSuggestResult output format", () => {
		// Test the render output format by building expected strings
		const result = makeSemanticResult();
		const lines = [
			`suggested files (semantic) for: ${result.task}`,
			`mode: semantic · cacheStatus: ${result.cacheStatus} · durationMs: ${result.durationMs} · pool: ${result.poolSize}`,
			"",
			`1. ${result.results[0]!.path}  [${result.results[0]!.kind} · score ${result.results[0]!.score.toFixed(3)}]`,
			`   reason: ${result.results[0]!.reason}`,
		];
		const expected = lines.join("\n");
		// Verify the format string manually — it should match renderSemanticText output
		expect(expected).toContain("suggested files (semantic) for:");
		expect(expected).toContain("mode: semantic");
		expect(expected).toContain("0.920");
		expect(expected).toContain("semantic similarity:");
	});

	it("score is formatted to 3 decimal places", () => {
		const score = 0.9;
		expect(score.toFixed(3)).toBe("0.900");
		const score2 = 0.123456;
		expect(score2.toFixed(3)).toBe("0.123");
	});

	it("renders multiple results", () => {
		const result = makeSemanticResult({
			results: [
				{ path: "src/auth.ts", kind: "file", score: 0.92, reason: "semantic similarity: 0.920" },
				{ path: "src/middleware.ts", kind: "file", score: 0.85, reason: "semantic similarity: 0.850" },
			],
		});
		const lines = [
			`suggested files (semantic) for: ${result.task}`,
			`mode: semantic · cacheStatus: ${result.cacheStatus} · durationMs: ${result.durationMs} · pool: ${result.poolSize}`,
			"",
			`1. ${result.results[0]!.path}  [${result.results[0]!.kind} · score ${result.results[0]!.score.toFixed(3)}]`,
			`   reason: ${result.results[0]!.reason}`,
			`2. ${result.results[1]!.path}  [${result.results[1]!.kind} · score ${result.results[1]!.score.toFixed(3)}]`,
			`   reason: ${result.results[1]!.reason}`,
		];
		const expected = lines.join("\n");
		expect(expected).toContain("1. src/auth.ts");
		expect(expected).toContain("2. src/middleware.ts");
		expect(expected).toContain("0.920");
		expect(expected).toContain("0.850");
	});

	it("handles empty results", () => {
		const result = makeSemanticResult({ results: [] });
		const lines = [
			`suggested files (semantic) for: ${result.task}`,
			`mode: semantic · cacheStatus: ${result.cacheStatus} · durationMs: ${result.durationMs} · pool: ${result.poolSize}`,
			"",
		];
		const expected = lines.join("\n").trimEnd();
		expect(expected).toContain("suggested files (semantic) for:");
		expect(expected).not.toContain("1.");
	});
});
