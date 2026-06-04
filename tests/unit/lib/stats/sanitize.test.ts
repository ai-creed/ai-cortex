import { describe, it, expect } from "vitest";
import {
	safeTag,
	errClassOf,
	safeMessage,
	errMessageOf,
	errCodeOf,
} from "../../../../src/lib/stats/sanitize.js";

describe("safeMessage", () => {
	it("returns null for non-strings and empty", () => {
		expect(safeMessage(undefined)).toBeNull();
		expect(safeMessage(null)).toBeNull();
		expect(safeMessage(123)).toBeNull();
		expect(safeMessage("")).toBeNull();
		expect(safeMessage("   ")).toBeNull();
	});

	it("collapses whitespace/newlines and strips control chars", () => {
		expect(safeMessage("unregistered type:\n  constraint")).toBe(
			"unregistered type: constraint",
		);
		expect(safeMessage("a\t\tb c")).toBe("a b c");
	});

	it("truncates to 300 chars with an ellipsis", () => {
		const long = "x".repeat(500);
		const out = safeMessage(long)!;
		expect(out.length).toBe(300);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("errMessageOf", () => {
	it("extracts a sanitized message from an Error", () => {
		expect(errMessageOf(new Error("required field missing: severity"))).toBe(
			"required field missing: severity",
		);
	});
	it("returns null for non-Errors", () => {
		expect(errMessageOf("nope")).toBeNull();
		expect(errMessageOf(undefined)).toBeNull();
	});
});

describe("errCodeOf", () => {
	it("returns a tag-safe .code when present (e.g. SqliteError)", () => {
		const e = Object.assign(new Error("fts5: syntax error"), {
			code: "SQLITE_ERROR",
		});
		expect(errCodeOf(e)).toBe("SQLITE_ERROR");
	});
	it("returns null when there is no usable code", () => {
		expect(errCodeOf(new Error("plain"))).toBeNull();
		expect(errCodeOf({ code: "has space" })).toBeNull();
	});
});

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
