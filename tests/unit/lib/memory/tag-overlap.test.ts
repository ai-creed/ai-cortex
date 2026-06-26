import { describe, it, expect } from "vitest";
import {
	normalize,
	stripBasicPlural,
	tagOverlapScore,
} from "../../../../src/lib/memory/tag-overlap.js";

describe("stripBasicPlural", () => {
	it("converts -ies to -y on words longer than 4 chars", () => {
		expect(stripBasicPlural("parties")).toBe("party");
		expect(stripBasicPlural("queries")).toBe("query");
	});
	it("strips the trailing s of -ses sibilant plurals (services → service, classes → class)", () => {
		expect(stripBasicPlural("services")).toBe("service");
		expect(stripBasicPlural("classes")).toBe("class");
	});
	it("strips the trailing s of -xes / -ches / -shes plurals", () => {
		expect(stripBasicPlural("boxes")).toBe("box");
		expect(stripBasicPlural("fixes")).toBe("fix");
		expect(stripBasicPlural("batches")).toBe("batch");
		expect(stripBasicPlural("washes")).toBe("wash");
	});
	it("strips plain trailing s on words longer than 2 chars (but NOT -ss)", () => {
		expect(stripBasicPlural("tests")).toBe("test");
		expect(stripBasicPlural("commits")).toBe("commit");
		expect(stripBasicPlural("less")).toBe("less");
		expect(stripBasicPlural("class")).toBe("class");
	});
	it("leaves short words alone", () => {
		expect(stripBasicPlural("cat")).toBe("cat");
		expect(stripBasicPlural("us")).toBe("us");
		expect(stripBasicPlural("is")).toBe("is");
	});
});

describe("normalize", () => {
	it("normalizes a typical file path: lowercases, splits, strips plurals, drops 1-char fragments", () => {
		const out = normalize("Services/server/import_matching.app-test.ts");
		expect(new Set(out)).toEqual(
			new Set(["service", "server", "import", "matching", "app", "test", "ts"]),
		);
	});
	it("normalizes unit-tests to {unit, test}", () => {
		expect(new Set(normalize("unit-tests"))).toEqual(new Set(["unit", "test"]));
	});
	it("normalizes git-commits to {git, commit}", () => {
		expect(new Set(normalize("git-commits"))).toEqual(new Set(["git", "commit"]));
	});
	it("preserves acronyms that survive after dropping single-char fragments", () => {
		expect(new Set(normalize("e2e"))).toEqual(new Set(["e2e"]));
	});
	it("returns empty for whitespace only", () => {
		expect(normalize("   ")).toEqual([]);
	});
});

describe("tagOverlapScore", () => {
	it("counts overlapping path tokens against tag tokens, no popular bonus when set is empty", () => {
		const pathTokens = new Set(["app", "test"]);
		const score = tagOverlapScore(pathTokens, ["unit-tests"], new Set());
		expect(score).toBe(1);
	});

	it("excludes excluded-set tags from the score (they no longer drive matches)", () => {
		const pathTokens = new Set(["app", "test"]);
		const score = tagOverlapScore(pathTokens, ["unit-tests"], new Set(["unit-tests"]));
		expect(score).toBe(0);
	});

	it("counts only non-excluded tags' token overlap (no popular bonus)", () => {
		const pathTokens = new Set(["test", "git"]);
		const score = tagOverlapScore(
			pathTokens,
			["unit-tests", "git-commits", "safety"],
			new Set(["unit-tests"]),
		);
		expect(score).toBe(1); // unit-tests excluded; git-commits → {git}; safety → none
	});

	it("returns 0 when no tag tokens overlap", () => {
		expect(
			tagOverlapScore(
				new Set(["alpha", "beta"]),
				["gamma", "delta-epsilon"],
				new Set(),
			),
		).toBe(0);
	});

	it("returns 0 for empty memoryTags", () => {
		expect(tagOverlapScore(new Set(["x"]), [], new Set())).toBe(0);
	});
});
