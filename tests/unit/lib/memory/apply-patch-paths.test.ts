import { describe, it, expect } from "vitest";
import { parseApplyPatchPaths } from "../../../../src/lib/memory/apply-patch-paths.js";

describe("parseApplyPatchPaths", () => {
	it("extracts Update/Add/Delete file paths", () => {
		const body = [
			"*** Begin Patch",
			"*** Update File: src/lib/memory/store.ts",
			"@@",
			"-old",
			"+new",
			"*** Add File: src/lib/memory/new.ts",
			"+content",
			"*** Delete File: src/lib/memory/old.ts",
			"*** End Patch",
		].join("\n");
		expect(parseApplyPatchPaths(body).sort()).toEqual(
			[
				"src/lib/memory/new.ts",
				"src/lib/memory/old.ts",
				"src/lib/memory/store.ts",
			].sort(),
		);
	});

	it("captures both sides of a rename (Move to)", () => {
		const body = [
			"*** Update File: src/old/path.ts",
			"*** Move to: src/new/path.ts",
			"@@",
			"-a",
			"+b",
		].join("\n");
		expect(parseApplyPatchPaths(body).sort()).toEqual(
			["src/new/path.ts", "src/old/path.ts"].sort(),
		);
	});

	it("returns [] for malformed / unparseable input", () => {
		expect(parseApplyPatchPaths("not a patch at all")).toEqual([]);
		expect(parseApplyPatchPaths("")).toEqual([]);
	});

	it("trims whitespace and dedups repeated paths", () => {
		const body = [
			"*** Update File:   src/a.ts  ",
			"*** Update File: src/a.ts",
		].join("\n");
		expect(parseApplyPatchPaths(body)).toEqual(["src/a.ts"]);
	});

	it("handles CRLF line endings (no stray \\r in paths)", () => {
		const body = [
			"*** Begin Patch",
			"*** Update File:   src/a.ts  ",
			"@@",
			"*** End Patch",
		].join("\r\n");
		expect(parseApplyPatchPaths(body)).toEqual(["src/a.ts"]);
	});

	it("preserves interior spaces in paths", () => {
		const body = "*** Update File: src/my dir/my file.ts";
		expect(parseApplyPatchPaths(body)).toEqual(["src/my dir/my file.ts"]);
	});

	it("ignores marker-looking text not at column 0", () => {
		const body = [
			"*** Update File: src/real.ts",
			"+*** Update File: src/fake.ts",
		].join("\n");
		expect(parseApplyPatchPaths(body)).toEqual(["src/real.ts"]);
	});
});
