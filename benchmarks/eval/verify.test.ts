// benchmarks/eval/verify.test.ts
import { describe, it, expect } from "vitest";
import { checkStructural, computeFilesCorrect } from "./verify.js";

describe("checkStructural", () => {
	it("returns true when pattern matches and shouldMatch is true", () => {
		expect(checkStructural("hello world\nfoo bar", "foo", true)).toBe(true);
	});

	it("returns false when pattern does not match and shouldMatch is true", () => {
		expect(checkStructural("hello world", "foo", true)).toBe(false);
	});

	it("returns true when pattern does not match and shouldMatch is false", () => {
		expect(checkStructural("hello world", "foo", false)).toBe(true);
	});

	it("returns false when pattern matches and shouldMatch is false", () => {
		expect(checkStructural("hello world\nfoo bar", "foo", false)).toBe(false);
	});

	it("supports regex patterns", () => {
		expect(checkStructural("slice(0, 3)", "slice\\(0,\\s*3\\)", true)).toBe(true);
	});
});

describe("computeFilesCorrect", () => {
	it("returns 1.0 for exact match", () => {
		expect(computeFilesCorrect(["a.ts", "b.ts"], ["a.ts", "b.ts"])).toBe(1);
	});

	it("returns 0.5 for partial overlap", () => {
		expect(computeFilesCorrect(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBeCloseTo(1 / 3);
	});

	it("returns 0 for no overlap", () => {
		expect(computeFilesCorrect(["a.ts"], ["b.ts"])).toBe(0);
	});

	it("returns 0 when both are empty", () => {
		expect(computeFilesCorrect([], [])).toBe(0);
	});

	it("handles touched superset of ground truth", () => {
		expect(computeFilesCorrect(["a.ts"], ["a.ts", "b.ts"])).toBeCloseTo(0.5);
	});
});
