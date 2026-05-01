import { describe, it, expect } from "vitest";
import {
	parseMemoryMarkdown,
	serializeMemoryMarkdown,
	bodyExcerpt,
} from "../../../../src/lib/memory/markdown.js";
import type { MemoryRecord } from "../../../../src/lib/memory/types.js";

const sampleRecord: MemoryRecord = {
	frontmatter: {
		id: "mem-2026-04-30-cache-atomic-writes-a3f9c1",
		type: "decision",
		status: "active",
		title: "Cache writes use atomic temp-file rename",
		version: 1,
		createdAt: "2026-04-30T09:00:00.000Z",
		updatedAt: "2026-04-30T09:00:00.000Z",
		source: "explicit",
		confidence: 1.0,
		pinned: false,
		scope: { files: ["src/lib/cache-store.ts"], tags: ["caching"] },
		provenance: [],
		supersedes: [],
		mergedInto: null,
		deprecationReason: null,
		promotedFrom: [],
		rewrittenAt: null,
	},
	body: "## Rule\nAll writes use atomic temp-file rename.\n\n## Why\nCrash safety.\n",
};

describe("serializeMemoryMarkdown", () => {
	it("produces a valid markdown file with --- delimited frontmatter", () => {
		const md = serializeMemoryMarkdown(sampleRecord);
		expect(md.startsWith("---\n")).toBe(true);
		const end = md.indexOf("\n---\n", 4);
		expect(end).toBeGreaterThan(0);
		expect(md.slice(end + 5)).toBe(sampleRecord.body);
	});
});

describe("parseMemoryMarkdown", () => {
	it("round-trips through serialize", () => {
		const md = serializeMemoryMarkdown(sampleRecord);
		const parsed = parseMemoryMarkdown(md);
		expect(parsed.frontmatter).toEqual(sampleRecord.frontmatter);
		expect(parsed.body).toBe(sampleRecord.body);
	});

	it("rejects content without a frontmatter block", () => {
		expect(() => parseMemoryMarkdown("no frontmatter here")).toThrow(
			/frontmatter/,
		);
	});

	it("rejects malformed YAML", () => {
		const bad = "---\nid: [unbalanced\n---\nbody";
		expect(() => parseMemoryMarkdown(bad)).toThrow();
	});
});

describe("bodyExcerpt", () => {
	it("returns up to 280 chars", () => {
		const long = "x".repeat(500);
		expect(bodyExcerpt(long).length).toBeLessThanOrEqual(280);
	});

	it("trims trailing whitespace and adds an ellipsis when truncated", () => {
		const long = "word ".repeat(100);
		const e = bodyExcerpt(long);
		expect(e.endsWith("…")).toBe(true);
	});

	it("returns the full body when ≤280", () => {
		expect(bodyExcerpt("short body")).toBe("short body");
	});
});

describe("rewrittenAt round-trip", () => {
	const baseFrontmatter = {
		id: "mem-rewritten-test",
		type: "decision",
		status: "active" as const,
		title: "x",
		version: 1,
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		source: "explicit" as const,
		confidence: 1,
		pinned: false,
		scope: { files: [], tags: [] },
		provenance: [],
		supersedes: [],
		mergedInto: null,
		deprecationReason: null,
		promotedFrom: [],
	};

	it("serializes and parses rewrittenAt as ISO timestamp", () => {
		const record: MemoryRecord = {
			frontmatter: { ...baseFrontmatter, rewrittenAt: "2026-05-01T12:34:56.000Z" },
			body: "## Body\ntest",
		};
		const md = serializeMemoryMarkdown(record);
		expect(md).toContain("rewrittenAt:");
		expect(md).toContain("2026-05-01T12:34:56.000Z");
		const parsed = parseMemoryMarkdown(md);
		expect(parsed.frontmatter.rewrittenAt).toBe("2026-05-01T12:34:56.000Z");
	});

	it("treats missing rewrittenAt as null", () => {
		const record: MemoryRecord = {
			frontmatter: { ...baseFrontmatter, rewrittenAt: null },
			body: "## Body\ntest",
		};
		const md = serializeMemoryMarkdown(record);
		const parsed = parseMemoryMarkdown(md);
		expect(parsed.frontmatter.rewrittenAt).toBeNull();
	});
});
