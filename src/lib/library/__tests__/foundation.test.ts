// src/lib/library/__tests__/foundation.test.ts
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashId, hashContent } from "../util/ids.js";
import { libraryRoot, indexDbPath, sourceDir } from "../paths.js";
import { deriveDocType, parseStatusHeader, valueWeight } from "../value.js";

describe("library foundation", () => {
	let prev: string | undefined;
	beforeEach(() => {
		prev = process.env.AI_CORTEX_CACHE_HOME;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
		else process.env.AI_CORTEX_CACHE_HOME = prev;
	});

	it("hashId is stable, order-sensitive, and 16 hex chars", () => {
		expect(hashId("a", "b")).toBe(hashId("a", "b"));
		expect(hashId("a", "b")).not.toBe(hashId("b", "a"));
		expect(hashId("x")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("hashContent changes when content changes", () => {
		expect(hashContent("one")).not.toBe(hashContent("two"));
		expect(hashContent("one")).toBe(hashContent("one"));
	});

	it("paths honor AI_CORTEX_CACHE_HOME and the library segment", () => {
		process.env.AI_CORTEX_CACHE_HOME = "/tmp/cache-x";
		expect(libraryRoot()).toBe(path.join("/tmp/cache-x", "library"));
		expect(sourceDir("abc")).toBe(path.join("/tmp/cache-x", "library", "abc"));
		expect(indexDbPath("abc")).toBe(
			path.join("/tmp/cache-x", "library", "abc", "index.sqlite"),
		);
	});

	it("paths fall back to ~/.cache/ai-cortex/v1/library", () => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		expect(libraryRoot()).toBe(
			path.join(os.homedir(), ".cache", "ai-cortex", "v1", "library"),
		);
	});

	it("deriveDocType maps known doc locations", () => {
		expect(deriveDocType("docs/superpowers/specs/x-design.md")).toBe("spec");
		expect(deriveDocType("docs/superpowers/deliberations/y.md")).toBe(
			"deliberation",
		);
		expect(deriveDocType("docs/superpowers/plans/z.md")).toBe("plan");
		expect(deriveDocType("docs/ideas/seed.md")).toBe("idea");
		expect(deriveDocType("README.md")).toBe("readme");
		expect(deriveDocType("notes/random.md")).toBe("doc");
	});

	it("parseStatusHeader reads a leading status/version line", () => {
		expect(parseStatusHeader("status: proposed\n\n# Title")).toBe("proposed");
		expect(parseStatusHeader("# Title\nversion: 2\n")).toBe("2");
		expect(parseStatusHeader("# Title\nbody text")).toBeUndefined();
	});

	it("valueWeight ranks specs above ideas and rewards pins, capped at 0.10", () => {
		const spec = valueWeight({ docType: "spec", mtimeMs: 0, pinned: false });
		const idea = valueWeight({ docType: "idea", mtimeMs: 0, pinned: false });
		expect(spec).toBeGreaterThan(idea);
		const pinned = valueWeight({
			docType: "spec",
			mtimeMs: 0,
			pinned: true,
			statusHeader: "x",
		});
		expect(pinned).toBeLessThanOrEqual(0.1);
		expect(pinned).toBeGreaterThan(spec);
	});
});
