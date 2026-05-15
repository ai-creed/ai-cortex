import { describe, it, expect } from "vitest";
import { safeTag, errClassOf } from "../../../../src/lib/stats/sanitize.js";

describe("safeTag", () => {
	it("accepts alphanumeric, underscore, hyphen up to 64 chars", () => {
		expect(safeTag("AbZ_09-x")).toBe("AbZ_09-x");
		expect(safeTag("a")).toBe("a");
		expect(safeTag("a".repeat(64))).toBe("a".repeat(64));
	});

	it("rejects spaces", () => {
		expect(safeTag("foo bar")).toBeNull();
	});

	it("rejects slashes", () => {
		expect(safeTag("foo/bar")).toBeNull();
		expect(safeTag("foo\\bar")).toBeNull();
	});

	it("rejects quotes", () => {
		expect(safeTag('foo"bar')).toBeNull();
		expect(safeTag("foo'bar")).toBeNull();
	});

	it("rejects unicode", () => {
		expect(safeTag("café")).toBeNull();
		expect(safeTag("\u{1f600}")).toBeNull();
	});

	it("rejects empty string", () => {
		expect(safeTag("")).toBeNull();
	});

	it("rejects strings over 64 chars", () => {
		expect(safeTag("a".repeat(65))).toBeNull();
	});

	it("rejects non-string inputs", () => {
		expect(safeTag(undefined as unknown as string)).toBeNull();
		expect(safeTag(null as unknown as string)).toBeNull();
		expect(safeTag(123 as unknown as string)).toBeNull();
	});
});

describe("errClassOf", () => {
	it("returns the constructor name for custom Error subclasses", () => {
		class MyErr extends Error {}
		expect(errClassOf(new MyErr("ignored"))).toBe("MyErr");
	});

	it("returns 'Error' for plain Error instances", () => {
		expect(errClassOf(new Error())).toBe("Error");
	});

	it("returns null for non-Error throwables", () => {
		expect(errClassOf("a string")).toBeNull();
		expect(errClassOf(42)).toBeNull();
		expect(errClassOf(undefined)).toBeNull();
		expect(errClassOf(null)).toBeNull();
		expect(errClassOf({ message: "x" })).toBeNull();
	});

	it("falls back to 'Error' when constructor name contains invalid chars", () => {
		const e = new Error("x");
		Object.defineProperty(e, "constructor", {
			value: { name: "bad name with spaces" },
		});
		expect(errClassOf(e)).toBe("Error");
	});
});
