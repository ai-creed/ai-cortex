import { describe, expect, it } from "vitest";
import { matchesScope, createMatchCache } from "../../../../src/lib/memory/scope-match.js";

describe("matchesScope — literal", () => {
	it("matches identical paths", () => {
		expect(matchesScope("src/foo.ts", "src/foo.ts")).toBe(true);
	});

	it("rejects different paths", () => {
		expect(matchesScope("src/foo.ts", "src/bar.ts")).toBe(false);
	});

	it("strips leading ./ on path", () => {
		expect(matchesScope("src/foo.ts", "./src/foo.ts")).toBe(true);
	});

	it("strips leading ./ on pattern", () => {
		expect(matchesScope("./src/foo.ts", "src/foo.ts")).toBe(true);
	});

	it("strips leading /", () => {
		expect(matchesScope("/src/foo.ts", "src/foo.ts")).toBe(true);
	});

	it("normalizes backslash to forward slash on path (Windows input)", () => {
		expect(matchesScope("src/foo.ts", "src\\foo.ts")).toBe(true);
	});

	it("normalizes backslash to forward slash on pattern", () => {
		expect(matchesScope("src\\foo.ts", "src/foo.ts")).toBe(true);
	});
});

describe("matchesScope — glob", () => {
	it("** matches nested paths", () => {
		expect(matchesScope("MainApp/**/*card*", "MainApp/lib/cards/card.ts")).toBe(true);
		expect(matchesScope("MainApp/**/*card*", "MainApp/cardroot.ts")).toBe(true);
	});

	it("** does not match outside the prefix", () => {
		expect(matchesScope("MainApp/**", "Other/foo.ts")).toBe(false);
	});

	it("* matches one segment", () => {
		expect(matchesScope("src/*.ts", "src/foo.ts")).toBe(true);
		expect(matchesScope("src/*.ts", "src/sub/foo.ts")).toBe(false);
	});

	it("? matches a single char", () => {
		expect(matchesScope("src/fo?.ts", "src/foo.ts")).toBe(true);
		expect(matchesScope("src/fo?.ts", "src/fooo.ts")).toBe(false);
	});

	it("[] character class", () => {
		expect(matchesScope("src/[abc].ts", "src/a.ts")).toBe(true);
		expect(matchesScope("src/[abc].ts", "src/d.ts")).toBe(false);
	});

	it("{} alternation", () => {
		expect(matchesScope("src/{foo,bar}.ts", "src/foo.ts")).toBe(true);
		expect(matchesScope("src/{foo,bar}.ts", "src/baz.ts")).toBe(false);
	});

	it("matches dotfiles (dot: true)", () => {
		expect(matchesScope("**/*.ts", ".hidden/foo.ts")).toBe(true);
	});

	it("normalizes Windows-style path before matching glob", () => {
		expect(matchesScope("MainApp/**/card.ts", "MainApp\\lib\\cards\\card.ts")).toBe(true);
	});
});

describe("matchesScope — malformed", () => {
	it("returns false for unclosed bracket, never throws", () => {
		expect(() => matchesScope("MainApp/[unclosed", "MainApp/foo.ts")).not.toThrow();
		expect(matchesScope("MainApp/[unclosed", "MainApp/foo.ts")).toBe(false);
	});
});

describe("createMatchCache", () => {
	it("returns a function that behaves like matchesScope", () => {
		const m = createMatchCache();
		expect(m("MainApp/**/*card*", "MainApp/lib/cards/card.ts")).toBe(true);
		expect(m("src/foo.ts", "src/bar.ts")).toBe(false);
	});

	it("compiles each unique pattern at most once (wall-time signal)", () => {
		// Wall-time signal instead of spying on picomatch's default export
		// (which has a brittle default-vs-named import shape across bundlers).
		// 1000 calls on the same pattern must finish in well under 50 ms;
		// without memoization, picomatch compilation is the dominant cost
		// and the loop blows past the bound.
		const m = createMatchCache();
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			m("MainApp/**/*card*", "MainApp/lib/cards/card.ts");
		}
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(50);
	});
});
