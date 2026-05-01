import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { openRetrieve, getMemory, recallMemory } from "../../../../src/lib/memory/retrieve.js";

let repoKey: string;
beforeEach(async () => { repoKey = await mkRepoKey("access-counters"); });
afterEach(async () => { await cleanupRepo(repoKey); });

describe("access counters", () => {
	it("get_memory increments getCount and sets lastAccessedAt", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "X",
				body: "## Body\nX",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const before = rh.index.rawDb()
				.prepare("SELECT get_count, last_accessed_at FROM memories WHERE id=?")
				.get(id) as { get_count: number; last_accessed_at: string | null };
			expect(before.get_count).toBe(0);
			expect(before.last_accessed_at).toBeNull();

			await getMemory(rh, id);

			const after = rh.index.rawDb()
				.prepare("SELECT get_count, last_accessed_at FROM memories WHERE id=?")
				.get(id) as { get_count: number; last_accessed_at: string | null };
			expect(after.get_count).toBe(1);
			expect(after.last_accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			await getMemory(rh, id);
			const after2 = rh.index.rawDb()
				.prepare("SELECT get_count FROM memories WHERE id=?")
				.get(id) as { get_count: number };
			expect(after2.get_count).toBe(2);
		} finally {
			rh.close();
		}
	});

	it("recall_memory does NOT increment getCount", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "POST endpoints",
				body: "## Body\nuse POST",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const hits = await recallMemory(rh, "POST endpoints", { limit: 5 });
			expect(hits.length).toBeGreaterThan(0);
			const after = rh.index.rawDb()
				.prepare("SELECT get_count FROM memories WHERE id=?")
				.get(id) as { get_count: number };
			expect(after.get_count).toBe(0);
		} finally {
			rh.close();
		}
	});
});
