import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { reconcileStore } from "../../../../src/lib/memory/reconcile.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { writeMemoryFile } from "../../../../src/lib/memory/store.js";
import { memoriesDir } from "../../../../src/lib/memory/paths.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import type { MemoryRecord } from "../../../../src/lib/memory/types.js";

let tmp: string;
const repoKey = "recon-test";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-recon-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => { delete process.env.AI_CORTEX_CACHE_HOME; });

function makeRecord(id: string): MemoryRecord {
	return {
		frontmatter: {
			id, type: "decision", status: "active", title: "T", version: 1,
			createdAt: "2026-04-30T00:00:00.000Z", updatedAt: "2026-04-30T00:00:00.000Z",
			source: "explicit", confidence: 1, pinned: false,
			scope: { files: [], tags: [] },
			provenance: [], supersedes: [], mergedInto: null,
			deprecationReason: null, promotedFrom: [],
		},
		body: "## Rule\ntest body",
	};
}

describe("reconcileStore", () => {
	it("adopts orphan .md files (no sqlite row)", async () => {
		// Write .md directly without going through lifecycle
		const r = makeRecord("mem-2026-04-30-orphan-aaa111");
		await writeMemoryFile(repoKey, r);

		const report = await reconcileStore(repoKey);
		expect(report.adopted).toContain("mem-2026-04-30-orphan-aaa111");
		expect(report.reindexed).toHaveLength(0);
		expect(report.phantomsRemoved).toHaveLength(0);

		// Row should now exist in sqlite
		const idx = openMemoryIndex(repoKey);
		expect(idx.getMemory("mem-2026-04-30-orphan-aaa111")).toBeDefined();
		const audit = idx.auditRows("mem-2026-04-30-orphan-aaa111");
		expect(audit.some(a => a.changeType === "reconcile" && a.reason === "adopted from disk")).toBe(true);
		idx.close();
	}, 30_000);

	it("removes phantom sqlite rows (no .md file, non-terminal status)", async () => {
		// Insert a sqlite row without a corresponding .md file
		const idx = openMemoryIndex(repoKey);
		const phantomId = "mem-2026-04-30-phantom-bbb222";
		idx.upsertMemory({
			id: phantomId, type: "decision", status: "active", title: "Phantom", version: 1,
			createdAt: "2026-04-30T00:00:00.000Z", updatedAt: "2026-04-30T00:00:00.000Z",
			source: "explicit", confidence: 1, pinned: false,
			scope: { files: [], tags: [] },
			provenance: [], supersedes: [], mergedInto: null,
			deprecationReason: null, promotedFrom: [],
		}, { bodyHash: "fakehash", bodyExcerpt: "x", body: "x" });
		idx.close();

		const report = await reconcileStore(repoKey);
		expect(report.phantomsRemoved).toContain(phantomId);

		const idx2 = openMemoryIndex(repoKey);
		expect(idx2.getMemory(phantomId)).toBeUndefined();
		idx2.close();
	}, 30_000);

	it("re-indexes when body-hash drifts", async () => {
		// Create memory normally
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision", title: "Drifted", body: "## Rule\noriginal",
				scope: { files: [], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }

		// Directly modify the .md file without updating sqlite (simulates drift)
		const mdPath = path.join(memoriesDir(repoKey), `${id}.md`);
		const text = await fs.readFile(mdPath, "utf8");
		await fs.writeFile(mdPath, text.replace("original", "modified"));

		const report = await reconcileStore(repoKey);
		expect(report.reindexed).toContain(id);

		// Verify hash was updated
		const idx = openMemoryIndex(repoKey);
		const row = idx.getMemory(id);
		const newHash = crypto.createHash("sha256").update("Drifted").update("\n\n").update("## Rule\nmodified").digest("hex");
		expect(row?.body_hash).toBe(newHash);
		idx.close();
	}, 30_000);
});
