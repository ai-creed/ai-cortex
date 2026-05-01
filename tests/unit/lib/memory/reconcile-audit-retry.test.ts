import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reconcileStore } from "../../../../src/lib/memory/reconcile.js";
import { writeMemoryFile } from "../../../../src/lib/memory/store.js";
import type { MemoryRecord } from "../../../../src/lib/memory/types.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("reconcileStore — audit UNIQUE retry", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("recon-audit");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("does not throw when reconcile runs twice over the same orphan", async () => {
		const rec: MemoryRecord = {
			frontmatter: {
				id: "mem-2026-04-30-orphan-aaaaaa",
				type: "decision",
				status: "active",
				title: "orphan decision",
				version: 1,
				createdAt: "2026-04-30T00:00:00Z",
				updatedAt: "2026-04-30T00:00:00Z",
				source: "explicit",
				confidence: 1.0,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: "Body of the orphan memory.",
		};
		await writeMemoryFile(repoKey, rec);

		const r1 = await reconcileStore(repoKey);
		expect(r1.adopted).toEqual(["mem-2026-04-30-orphan-aaaaaa"]);

		// Simulate the retry path: drop the memory row only, leaving the audit row intact.
		const { openMemoryIndex } =
			await import("../../../../src/lib/memory/index.js");
		const idx = openMemoryIndex(repoKey);
		idx
			.rawDb()
			.prepare("DELETE FROM memories WHERE id = ?")
			.run(rec.frontmatter.id);
		idx.close();

		// Second reconcile must succeed — the original bug crashed here with UNIQUE constraint failed.
		const r2 = await reconcileStore(repoKey);
		expect(r2.adopted).toEqual(["mem-2026-04-30-orphan-aaaaaa"]);
	});
});
