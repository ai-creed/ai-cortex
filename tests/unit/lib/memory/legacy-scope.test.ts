import { describe, it, expect } from "vitest";
import { parseLegacyScopeTrailer } from "../../../../src/lib/memory/legacy-scope.js";

describe("parseLegacyScopeTrailer", () => {
	it("returns matched=false when body has no legacy trailer", () => {
		const body = "## Rule\nUse strictEqual instead of equal.\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(false);
		expect(out.scopeFiles).toEqual([]);
		expect(out.scopeTags).toEqual([]);
		expect(out.strippedBody).toBe(body);
	});

	it("parses JSON-array scopeFiles and scopeTags from a terminal trailer", () => {
		const body =
			"## Rule\nUse strictEqual.\n\n" +
			'<scopeFiles>["**/*.app-test.ts", "Test/src/**/*.ts"]</scopeFiles>\n' +
			'<scopeTags>["unit-tests", "assertions"]</scopeTags>\n';
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual(["**/*.app-test.ts", "Test/src/**/*.ts"]);
		expect(out.scopeTags).toEqual(["unit-tests", "assertions"]);
		expect(out.strippedBody.trim()).toBe("## Rule\nUse strictEqual.");
	});

	it("parses comma-separated scopeFiles when payload is plain text (does not start with [ or {)", () => {
		const body =
			"## Rule\nbody.\n\n" +
			"<scopeFiles>**/*.app-test.ts, Test/src/**/*.ts</scopeFiles>\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual(["**/*.app-test.ts", "Test/src/**/*.ts"]);
		expect(out.scopeTags).toEqual([]);
	});

	it("strips non-scope trailers (source/confidence/globalScope/</invoke>) even when scope tags are absent", () => {
		const body =
			"## Rule\nbody.\n\n" +
			"<source>explicit</source>\n" +
			"<confidence>1</confidence>\n" +
			"<globalScope>false</globalScope>\n" +
			"</invoke>\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual([]);
		expect(out.scopeTags).toEqual([]);
		expect(out.strippedBody.trim()).toBe("## Rule\nbody.");
	});

	it("strips the full canonical legacy fixture cleanly", () => {
		const body =
			"## Rule\nIn unit tests, use `assert.strictEqual` instead of `assert.equal`.\n\n" +
			'<scopeFiles>["**/*.app-test.ts", "Test/src/**/*.ts"]</scopeFiles>\n' +
			'<scopeTags>["unit-tests", "code-style", "assertions"]</scopeTags>\n' +
			"<source>explicit</source>\n" +
			"<confidence>1</confidence>\n" +
			"<globalScope>false</globalScope>\n" +
			"</invoke>\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual(["**/*.app-test.ts", "Test/src/**/*.ts"]);
		expect(out.scopeTags).toEqual(["unit-tests", "code-style", "assertions"]);
		expect(out.strippedBody.trim()).toBe(
			"## Rule\nIn unit tests, use `assert.strictEqual` instead of `assert.equal`.",
		);
	});

	it("rejects payload that looks like JSON (starts with [ or {) but fails to parse — returns []", () => {
		const body = "## Rule\nbody.\n\n<scopeFiles>{not valid</scopeFiles>\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual([]);
		expect(out.scopeTags).toEqual([]);
		expect(out.strippedBody.trim()).toBe("## Rule\nbody.");
	});

	it("deduplicates and trims parsed values", () => {
		const body =
			"## Rule\nx.\n\n" +
			'<scopeFiles>[" a.ts ", "a.ts", "b.ts"]</scopeFiles>\n';
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual(["a.ts", "b.ts"]);
	});

	it("preserves a mid-body <scopeFiles> mention when prose follows it", () => {
		const body =
			"## Rule\nThe agent emits a `<scopeFiles>` tag when recording a rule.\n\n" +
			"More prose after the mention.\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(false);
		expect(out.strippedBody).toBe(body);
	});

	it("preserves a <scopeFiles> mention inside a fenced code block", () => {
		const body =
			"## Rule\nExample of malformed shape:\n\n" +
			'```\n<scopeFiles>["a.ts"]</scopeFiles>\n```\n\n' +
			"This is documentation, not a real trailer.\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(false);
		expect(out.strippedBody).toBe(body);
	});

	it("stops walking when it hits a non-trailer non-blank line", () => {
		// scopeFiles tag is in the middle, followed by prose. Should NOT match.
		const body =
			"## Rule\nbody.\n\n" +
			'<scopeFiles>["a.ts"]</scopeFiles>\n' +
			"some prose after the tag\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(false);
		expect(out.strippedBody).toBe(body);
	});

	it("strips a trailer block that has blank lines between its tags", () => {
		const body =
			"## Rule\nbody.\n\n" +
			'<scopeFiles>["a.ts"]</scopeFiles>\n' +
			"\n" +
			'<scopeTags>["t1"]</scopeTags>\n' +
			"\n" +
			"</invoke>\n";
		const out = parseLegacyScopeTrailer(body);
		expect(out.matched).toBe(true);
		expect(out.scopeFiles).toEqual(["a.ts"]);
		expect(out.scopeTags).toEqual(["t1"]);
		expect(out.strippedBody.trim()).toBe("## Rule\nbody.");
	});
});
