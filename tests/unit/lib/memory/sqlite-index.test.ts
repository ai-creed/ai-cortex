import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import type { MemoryFrontmatter } from "../../../../src/lib/memory/types.js";

let tmp: string;
const repoKey = "testrepo";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-idx-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
});

function fm(
	id: string,
	overrides: Partial<MemoryFrontmatter> = {},
): MemoryFrontmatter {
	return {
		id,
		type: "decision",
		status: "active",
		title: "T",
		version: 1,
		createdAt: "2026-04-30T00:00:00.000Z",
		updatedAt: "2026-04-30T00:00:00.000Z",
		source: "explicit",
		confidence: 1,
		pinned: false,
		scope: { files: [], tags: [] },
		provenance: [],
		supersedes: [],
		mergedInto: null,
		deprecationReason: null,
		promotedFrom: [],
		...overrides,
	};
}

describe("openMemoryIndex", () => {
	it("creates the schema (memories, memory_scope, memory_links, memory_audit, memory_fts)", () => {
		const idx = openMemoryIndex(repoKey);
		const tables = idx.rawAllTables();
		for (const t of [
			"memories",
			"memory_scope",
			"memory_links",
			"memory_audit",
			"memory_fts",
		]) {
			expect(tables).toContain(t);
		}
		idx.close();
	});

	it("uses WAL mode", () => {
		const idx = openMemoryIndex(repoKey);
		expect(idx.rawJournalMode()).toBe("wal");
		idx.close();
	});
});

describe("upsertMemory", () => {
	it("inserts new and updates existing rows; populates body_hash and body_excerpt", () => {
		const idx = openMemoryIndex(repoKey);
		idx.upsertMemory(fm("mem-x"), {
			bodyHash: "h1",
			bodyExcerpt: "e1",
			body: "full",
		});
		const row = idx.getMemory("mem-x");
		expect(row).toMatchObject({
			id: "mem-x",
			body_hash: "h1",
			body_excerpt: "e1",
		});

		idx.upsertMemory(fm("mem-x", { version: 2 }), {
			bodyHash: "h2",
			bodyExcerpt: "e2",
			body: "full2",
		});
		const row2 = idx.getMemory("mem-x");
		expect(row2?.version).toBe(2);
		expect(row2?.body_hash).toBe("h2");
		idx.close();
	});

	it("syncs scope rows on each upsert", () => {
		const idx = openMemoryIndex(repoKey);
		idx.upsertMemory(
			fm("mem-x", { scope: { files: ["a.ts"], tags: ["t1", "t2"] } }),
			{ bodyHash: "h", bodyExcerpt: "e", body: "b" },
		);
		expect(
			idx
				.scopeRows("mem-x")
				.sort((a, b) => (a.kind + a.value).localeCompare(b.kind + b.value)),
		).toEqual(
			[
				{ kind: "file", value: "a.ts" },
				{ kind: "tag", value: "t1" },
				{ kind: "tag", value: "t2" },
			].sort((a, b) => (a.kind + a.value).localeCompare(b.kind + b.value)),
		);

		idx.upsertMemory(fm("mem-x", { scope: { files: [], tags: ["t1"] } }), {
			bodyHash: "h2",
			bodyExcerpt: "e",
			body: "b",
		});
		expect(idx.scopeRows("mem-x")).toEqual([{ kind: "tag", value: "t1" }]);
		idx.close();
	});

	it("syncs FTS5 with the full body, not the excerpt", () => {
		const idx = openMemoryIndex(repoKey);
		const longBody =
			"## Steps\n1. step one\n2. step two\n" +
			"filler ".repeat(200) +
			" UNIQUE_LITERAL_AT_END";
		idx.upsertMemory(fm("mem-x", { title: "How to" }), {
			bodyHash: "h",
			bodyExcerpt: "preview only",
			body: longBody,
		});
		const hits = idx.searchFts("UNIQUE_LITERAL_AT_END", 5);
		expect(hits.map((h) => h.memoryId)).toContain("mem-x");
		idx.close();
	});
});

describe("appendAudit", () => {
	it("appends in version order; PRIMARY KEY (memory_id, version) prevents duplicates", () => {
		const idx = openMemoryIndex(repoKey);
		idx.upsertMemory(fm("mem-x"), {
			bodyHash: "h1",
			bodyExcerpt: "e",
			body: "b",
		});
		idx.appendAudit({
			memoryId: "mem-x",
			version: 1,
			ts: "2026-04-30T00:00:00Z",
			changeType: "create",
			prevBodyHash: null,
			prevBody: null,
			reason: null,
			agentId: "test",
		});
		expect(() =>
			idx.appendAudit({
				memoryId: "mem-x",
				version: 1,
				ts: "x",
				changeType: "update",
				prevBodyHash: null,
				prevBody: null,
				reason: null,
				agentId: null,
			}),
		).toThrow(/UNIQUE/i);
		idx.close();
	});
});

describe("links", () => {
	it("inserts and removes a typed edge; FK cascade on memory delete", () => {
		const idx = openMemoryIndex(repoKey);
		idx.upsertMemory(fm("a"), { bodyHash: "h", bodyExcerpt: "e", body: "b" });
		idx.upsertMemory(fm("b"), { bodyHash: "h", bodyExcerpt: "e", body: "b" });
		idx.addLink({
			srcId: "a",
			dstId: "b",
			relType: "supports",
			createdAt: "2026-04-30T00:00:00Z",
		});
		expect(idx.linksFrom("a")).toHaveLength(1);
		idx.removeLink("a", "b", "supports");
		expect(idx.linksFrom("a")).toHaveLength(0);

		idx.addLink({
			srcId: "a",
			dstId: "b",
			relType: "supports",
			createdAt: "2026-04-30T00:00:00Z",
		});
		idx.deleteMemoryRow("a");
		expect(idx.linksFrom("a")).toHaveLength(0);
		idx.close();
	});
});
