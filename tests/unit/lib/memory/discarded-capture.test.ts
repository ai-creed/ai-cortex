import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import {
	openLifecycle,
	createDiscardedCapture,
	createMemory,
	trashMemory,
	untrashMemory,
	INTAKE_DISCARD_REASON,
} from "../../../../src/lib/memory/lifecycle.js";
import { readMemoryVector } from "../../../../src/lib/memory/embed.js";
import { memoryFilePath } from "../../../../src/lib/memory/paths.js";
import { openRetrieve, listMemories } from "../../../../src/lib/memory/retrieve.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

let repoKey: string;
afterEach(async () => {
	if (repoKey) await cleanupRepo(repoKey);
});

describe("createDiscardedCapture", () => {
	it("is born in trash: trashed index row, file in trash/, audit reason, NO vector", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const lc = await openLifecycle(repoKey);
		try {
			const id = await createDiscardedCapture(lc, {
				title: "commit and push",
				body: "commit and push\n\n_Acknowledged:_ Done.",
				scope: { files: [], tags: ["commit"] },
				reason: INTAKE_DISCARD_REASON,
			});
			const row = lc.index.getMemory(id);
			expect(row).not.toBeNull();
			expect(row!.status).toBe("trashed");
			expect(row!.type).toBe("capture");
			await expect(
				fs.access(memoryFilePath(repoKey, id, "trash")),
			).resolves.toBeUndefined();
			// assert vector ABSENCE, not just terminal status (spec §9.1)
			expect(await readMemoryVector(repoKey, id)).toBeNull();
			const audit = lc.index
				.rawDb()
				.prepare("SELECT reason, change_type FROM memory_audit WHERE memory_id = ?")
				.all(id) as { reason: string; change_type: string }[];
			expect(audit).toHaveLength(1);
			expect(audit[0]!.reason).toBe(INTAKE_DISCARD_REASON);
			expect(audit[0]!.change_type).toBe("create");
		} finally {
			lc.close();
		}
	});

	it("fault injection after the file write: compensates the file, leaves no index row", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const lc = await openLifecycle(repoKey);
		try {
			// Fail AFTER the first durable side effect (trash file write): the
			// index tx throws mid-flight, sqlite rolls back, and the compensation
			// must remove the orphan file (spec §9.2).
			vi.spyOn(lc.index, "appendAudit").mockImplementation(() => {
				throw new Error("injected index failure");
			});
			await expect(
				createDiscardedCapture(lc, {
					title: "boom",
					body: "boom",
					scope: { files: [], tags: [] },
					reason: INTAKE_DISCARD_REASON,
				}),
			).rejects.toThrow("injected index failure");
			// no divergent state: no row, and no orphan file left in trash/
			const rows = lc.index
				.rawDb()
				.prepare("SELECT id FROM memories")
				.all() as { id: string }[];
			expect(rows).toHaveLength(0);
			const { trashDir } = await import("../../../../src/lib/memory/paths.js");
			const files = await fs
				.readdir(trashDir(repoKey))
				.catch(() => [] as string[]);
			expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(0);
		} finally {
			vi.restoreAllMocks();
			lc.close();
		}
	});
});

describe("type-aware untrash", () => {
	it("a routed capture restores to candidate, never active, and stays out of active retrieval", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const lc = await openLifecycle(repoKey);
		let id = "";
		try {
			id = await createDiscardedCapture(lc, {
				title: "maybe a gem after all",
				body: "maybe a gem after all",
				scope: { files: [], tags: [] },
				reason: INTAKE_DISCARD_REASON,
			});
			await untrashMemory(lc, id);
			const row = lc.index.getMemory(id)!;
			expect(row.status).toBe("candidate");
			expect(row.type).toBe("capture");
		} finally {
			lc.close();
		}
		// Surfacing exclusion at the RETRIEVAL layer (spec §9.7): the restored
		// capture must be absent from the active listing the surfacing paths
		// select from, and present in the candidate review queue.
		const rh = openRetrieve(repoKey);
		try {
			const activeIds = listMemories(rh, { status: ["active"] }).map(
				(r) => r.id,
			);
			expect(activeIds).not.toContain(id);
			const candidateIds = listMemories(rh, { status: ["candidate"] }).map(
				(r) => r.id,
			);
			expect(candidateIds).toContain(id);
		} finally {
			rh.close();
		}
	});

	it("non-capture untrash behavior is unchanged (restores to active)", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const lc = await openLifecycle(repoKey);
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "keep tabs not spaces",
				body: "keep tabs not spaces",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await trashMemory(lc, id, "test");
			await untrashMemory(lc, id);
			expect(lc.index.getMemory(id)!.status).toBe("active");
		} finally {
			lc.close();
		}
	});
});
