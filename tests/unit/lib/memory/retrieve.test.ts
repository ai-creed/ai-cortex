import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getMemory, listMemories, auditMemory, searchMemories, openRetrieve } from "../../../../src/lib/memory/retrieve.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";

let tmp: string;
const repoKey = "ret-test";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-ret-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => { delete process.env.AI_CORTEX_CACHE_HOME; });

describe("getMemory", () => {
	it("returns full MemoryRecord for an existing memory", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, { type: "decision", title: "T", body: "## Rule\nx", scope: { files: [], tags: [] }, source: "explicit" });
		} finally { lc.close(); }

		const rh = openRetrieve(repoKey);
		try {
			const record = await getMemory(rh, id);
			expect(record.frontmatter.id).toBe(id);
			expect(record.body).toContain("x");
		} finally { rh.close(); }
	}, 30_000);

	it("throws for a missing id", async () => {
		const rh = openRetrieve(repoKey);
		try {
			await expect(getMemory(rh, "mem-nonexistent-x")).rejects.toThrow(/not found/);
		} finally { rh.close(); }
	});
});

describe("listMemories", () => {
	it("filters by type", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, { type: "decision", title: "D", body: "x", scope: { files: [], tags: [] }, source: "explicit" });
			await createMemory(lc, { type: "pattern", title: "P", body: "x", scope: { files: [], tags: [] }, source: "explicit" });
		} finally { lc.close(); }

		const rh = openRetrieve(repoKey);
		try {
			const all = listMemories(rh);
			expect(all).toHaveLength(2);
			const decisions = listMemories(rh, { type: ["decision"] });
			expect(decisions).toHaveLength(1);
			expect(decisions[0].type).toBe("decision");
		} finally { rh.close(); }
	}, 30_000);
});

describe("auditMemory", () => {
	it("returns audit rows in version order", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, { type: "decision", title: "T", body: "## Rule\nx", scope: { files: [], tags: [] }, source: "explicit" });
			await import("../../../../src/lib/memory/lifecycle.js").then(m => m.updateMemory(lc, id, { body: "## Rule\ny", reason: "r" }));
		} finally { lc.close(); }

		const rh = openRetrieve(repoKey);
		try {
			const rows = auditMemory(rh, id);
			expect(rows).toHaveLength(2);
			expect(rows[0].changeType).toBe("create");
			expect(rows[1].changeType).toBe("update");
		} finally { rh.close(); }
	}, 30_000);
});

describe("searchMemories", () => {
	it("finds memories by full-body content (not just excerpt)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision", title: "Long decision",
				body: "## Rule\n" + "padding ".repeat(100) + " UNIQUE_FTS_NEEDLE_XYZ",
				scope: { files: [], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }

		const rh = openRetrieve(repoKey);
		try {
			const hits = searchMemories(rh, "UNIQUE_FTS_NEEDLE_XYZ");
			expect(hits.length).toBeGreaterThan(0);
			expect(hits[0].title).toBe("Long decision");
		} finally { rh.close(); }
	}, 30_000);
});
