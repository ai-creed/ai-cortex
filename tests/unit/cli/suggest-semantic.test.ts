// tests/unit/cli/suggest-semantic.test.ts
import { describe, expect, it } from "vitest";
import { renderSemanticText } from "../../../src/cli.js";
import type { SemanticSuggestResult } from "../../../src/lib/suggest.js";

function makeResult(overrides: Partial<SemanticSuggestResult> = {}): SemanticSuggestResult {
	return {
		mode: "semantic",
		cacheStatus: "fresh",
		task: "find auth middleware",
		from: null,
		durationMs: 42,
		poolSize: 10,
		results: [
			{ path: "src/auth.ts", kind: "file", score: 0.92, reason: "semantic similarity: 0.920" },
			{ path: "docs/auth.md", kind: "doc", score: 0.75, reason: "semantic similarity: 0.750" },
		],
		...overrides,
	};
}

describe("renderSemanticText", () => {
	it("renders header and meta line", () => {
		const output = renderSemanticText(makeResult());
		expect(output).toContain("suggested files (semantic) for: find auth middleware");
		expect(output).toContain("mode: semantic · cacheStatus: fresh · durationMs: 42 · pool: 10");
	});

	it("renders results with score to 3 decimal places", () => {
		const output = renderSemanticText(makeResult());
		expect(output).toContain("1. src/auth.ts  [file · score 0.920]");
		expect(output).toContain("   reason: semantic similarity: 0.920");
		expect(output).toContain("2. docs/auth.md  [doc · score 0.750]");
	});

	it("renders empty results without crashing", () => {
		const output = renderSemanticText(makeResult({ results: [] }));
		expect(output).toContain("suggested files (semantic) for:");
		expect(output).not.toContain("1."); // no results
	});

	it("blank line separates meta from results", () => {
		const lines = renderSemanticText(makeResult()).split("\n");
		// line 0: header, line 1: meta, line 2: blank, line 3+: results
		expect(lines[2]).toBe("");
		expect(lines[3]).toMatch(/^1\./);
	});

	it("score formatting: 0.9 renders as 0.900", () => {
		const output = renderSemanticText(
			makeResult({
				results: [{ path: "src/a.ts", kind: "file", score: 0.9, reason: "x" }],
			}),
		);
		expect(output).toContain("score 0.900");
	});
});
