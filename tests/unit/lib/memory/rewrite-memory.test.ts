import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
	openLifecycle,
	createMemory,
	rewriteMemory,
	deprecateMemory,
	trashMemory,
	mergeMemories,
} from "../../../../src/lib/memory/lifecycle.js";
import { readMemoryFile } from "../../../../src/lib/memory/store.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("rewrite-memory");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

describe("rewriteMemory", () => {
	it("auto-promotes a candidate to active with confidence 1.0 and updates content", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "raw correction snippet",
				body: "## Body\nraw transcript",
				scope: { files: [], tags: [] },
				source: "extracted",
				confidence: 0.5,
			});
			expect(lc.index.getMemory(id)?.status).toBe("candidate");

			await rewriteMemory(lc, id, {
				title: "Use POST for create endpoints",
				body: "## Rule\nUse POST.\n\n## Rationale\nIdempotent semantics.",
				scopeFiles: ["src/api.ts"],
				scopeTags: ["api"],
			});

			const row = lc.index.getMemory(id);
			expect(row?.status).toBe("active");
			expect(row?.title).toBe("Use POST for create endpoints");
			expect(row?.confidence).toBe(1.0);
			expect(row?.rewritten_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			const record = await readMemoryFile(repoKey, id, "memories");
			expect(record.frontmatter.rewrittenAt).toBe(row?.rewritten_at);
			expect(record.frontmatter.scope.files).toEqual(["src/api.ts"]);
			expect(record.frontmatter.scope.tags).toEqual(["api"]);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("leaves an already-active memory active and updates content (preserves confidence)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "old title",
				body: "## Body\nold",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			expect(lc.index.getMemory(id)?.status).toBe("active");
			const beforeConfidence = lc.index.getMemory(id)!.confidence;

			await rewriteMemory(lc, id, {
				title: "new title",
				body: "## Rule\nnew",
				scopeFiles: [],
				scopeTags: [],
			});

			const row = lc.index.getMemory(id);
			expect(row?.status).toBe("active");
			expect(row?.title).toBe("new title");
			expect(row?.confidence).toBe(beforeConfidence);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("errors when memory is trashed", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "x",
				body: "## Body\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await trashMemory(lc, id, "test");
			await expect(
				rewriteMemory(lc, id, {
					title: "y",
					body: "## Rule\ny",
					scopeFiles: [],
					scopeTags: [],
				}),
			).rejects.toThrow(/trashed/);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("errors when memory is merged_into", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const aId = await createMemory(lc, {
				type: "decision",
				title: "a",
				body: "## Body\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			const bId = await createMemory(lc, {
				type: "decision",
				title: "b",
				body: "## Body\nb",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await mergeMemories(lc, aId, bId, "## Body\nmerged");
			await expect(
				rewriteMemory(lc, aId, {
					title: "y",
					body: "## Rule\ny",
					scopeFiles: [],
					scopeTags: [],
				}),
			).rejects.toThrow(/merged_into/);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("errors when memory is purged_redacted", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "x",
				body: "## Body\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			// Manually set purged_redacted status (simulating purgeMemory redact behavior)
			// to test the guard without the file I/O complications
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memories SET status='purged_redacted', title='<redacted>', body_excerpt='<redacted>' WHERE id=?",
				)
				.run(id);

			// loadCurrent will fail because file is gone, so error message will be ENOENT
			// but the function should check status first. Let's verify the guard works:
			const memRow = lc.index.getMemory(id);
			expect(memRow?.status).toBe("purged_redacted");

			await expect(
				rewriteMemory(lc, id, {
					title: "y",
					body: "## Rule\ny",
					scopeFiles: [],
					scopeTags: [],
				}),
			).rejects.toThrow(/cannot rewrite a purged_redacted/);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("appends an audit row with reason 'rewrite'", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "raw",
				body: "## Body\nraw",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			await rewriteMemory(lc, id, {
				title: "clean",
				body: "## Rule\nclean",
				scopeFiles: [],
				scopeTags: [],
			});
			const audit = lc.index.auditRows(id);
			const last = audit[audit.length - 1]!;
			expect(last.changeType).toBe("update");
			expect(last.reason).toBe("rewrite");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("allows rewriting a deprecated memory (status stays deprecated)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "old rule",
				body: "## Rule\nold",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await deprecateMemory(lc, id, "obsolete");
			expect(lc.index.getMemory(id)?.status).toBe("deprecated");

			await rewriteMemory(lc, id, {
				title: "refined rule",
				body: "## Rule\nrefined",
				scopeFiles: [],
				scopeTags: [],
			});

			const row = lc.index.getMemory(id);
			expect(row?.status).toBe("deprecated");
			expect(row?.title).toBe("refined rule");
		} finally {
			lc.close();
		}
	}, 30_000);
});
