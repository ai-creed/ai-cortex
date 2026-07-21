import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import {
	openLifecycle,
	createDiscardedCapture,
	INTAKE_DISCARD_REASON,
} from "../../../../src/lib/memory/lifecycle.js";
import { readMemoryVector } from "../../../../src/lib/memory/embed.js";
import { memoryFilePath } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("createDiscardedCapture", () => {
	let repoKey: string;
	afterEach(async () => {
		if (repoKey) await cleanupRepo(repoKey);
	});

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
