// src/lib/library/__tests__/doc-chunker.test.ts
import { describe, expect, it } from "vitest";
import { chunkDoc, DEFAULT_MAX_CHARS } from "../doc-chunker.js";

describe("chunkDoc", () => {
	it("produces one chunk per heading section with the heading chain", () => {
		const text = [
			"# Title",
			"intro line",
			"",
			"## Section A",
			"a body",
			"",
			"## Section B",
			"b body",
		].join("\n");
		const chunks = chunkDoc(text);
		expect(chunks.length).toBe(3);
		expect(chunks[0].headingPath).toEqual(["Title"]);
		expect(chunks[0].text).toContain("intro line");
		expect(chunks[1].headingPath).toEqual(["Title", "Section A"]);
		expect(chunks[2].headingPath).toEqual(["Title", "Section B"]);
		// ordinals are sequential
		expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
	});

	it("tracks 1-based inclusive line spans", () => {
		const text = ["# H", "l2", "l3"].join("\n");
		const chunks = chunkDoc(text);
		expect(chunks[0].lineStart).toBe(1);
		expect(chunks[0].lineEnd).toBe(3);
	});

	it("nests deeper headings under their ancestors", () => {
		const text = ["# A", "", "## B", "", "### C", "deep"].join("\n");
		const chunks = chunkDoc(text);
		const deep = chunks.find((c) => c.text.includes("deep"))!;
		expect(deep.headingPath).toEqual(["A", "B", "C"]);
	});

	it("splits a section longer than maxChars into overlapping windows", () => {
		const long = Array.from(
			{ length: 50 },
			(_, i) => `line ${i} with some words here`,
		).join("\n");
		const text = `# Big\n${long}`;
		const chunks = chunkDoc(text, { maxChars: 200, overlapChars: 40 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.text.length).toBeLessThanOrEqual(200 + 40);
			expect(c.headingPath).toEqual(["Big"]);
			expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
		}
	});

	it("handles a doc with no headings as a single (or windowed) chunk", () => {
		const chunks = chunkDoc("just some prose\nwith two lines");
		expect(chunks.length).toBe(1);
		expect(chunks[0].headingPath).toEqual([]);
		expect(DEFAULT_MAX_CHARS).toBeGreaterThan(0);
	});
});
