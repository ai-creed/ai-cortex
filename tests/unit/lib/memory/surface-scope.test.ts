import { describe, it, expect } from "vitest";
import { patternSpecificity } from "../../../../src/lib/memory/scope-match.js";

describe("patternSpecificity", () => {
	it("literal patterns outrank any glob", () => {
		expect(patternSpecificity("src/lib/memory/store.ts")).toBeGreaterThan(
			patternSpecificity("src/lib/memory/*.ts"),
		);
	});

	it("longer literal prefix is more specific among globs", () => {
		expect(patternSpecificity("src/lib/memory/*.ts")).toBeGreaterThan(
			patternSpecificity("src/**/*.ts"),
		);
	});

	it("is deterministic and normalizes path separators", () => {
		expect(patternSpecificity("src\\lib\\a.ts")).toBe(
			patternSpecificity("src/lib/a.ts"),
		);
	});

	it("two literals tie-break by length (longer = more specific)", () => {
		expect(patternSpecificity("a/b/c.ts")).toBeGreaterThan(
			patternSpecificity("a.ts"),
		);
	});
});
