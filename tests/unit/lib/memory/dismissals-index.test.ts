import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";

let repoKey: string;
beforeEach(async () => { repoKey = await mkRepoKey("dismissals-index"); });
afterEach(async () => { await cleanupRepo(repoKey); });

describe("memory_dismissals accessors", () => {
	it("increments under the same version and suppresses at K", () => {
		const idx = openMemoryIndex(repoKey);
		try {
			expect(idx.isDismissed("m1", "a.ts", 1, 2)).toBe(false);
			idx.recordDismissal("m1", "a.ts", 1, 1000);
			expect(idx.isDismissed("m1", "a.ts", 1, 2)).toBe(false); // count 1 < 2
			idx.recordDismissal("m1", "a.ts", 1, 2000);
			expect(idx.isDismissed("m1", "a.ts", 1, 2)).toBe(true); // count 2 >= 2
		} finally { idx.close(); }
	});

	it("resets the count when the version differs (no K+1 carry-over)", () => {
		const idx = openMemoryIndex(repoKey);
		try {
			idx.recordDismissal("m1", "a.ts", 1, 1000);
			idx.recordDismissal("m1", "a.ts", 1, 2000); // count = 2 at version 1
			expect(idx.isDismissed("m1", "a.ts", 1, 2)).toBe(true);
			// version bumps to 2, one new dismissal:
			idx.recordDismissal("m1", "a.ts", 2, 3000);
			expect(idx.isDismissed("m1", "a.ts", 1, 2)).toBe(false); // stale version never suppresses
			expect(idx.isDismissed("m1", "a.ts", 2, 2)).toBe(false); // reset to 1, < 2
		} finally { idx.close(); }
	});

	it("stores and prunes session watermarks", () => {
		const idx = openMemoryIndex(repoKey);
		try {
			expect(idx.getWatermark("s1")).toBeNull();
			idx.setWatermark("s1", 5000);
			expect(idx.getWatermark("s1")).toBe(5000);
			idx.setWatermark("s1", 9000); // upsert
			expect(idx.getWatermark("s1")).toBe(9000);
			idx.pruneReconciledSessions(9001);
			expect(idx.getWatermark("s1")).toBeNull();
		} finally { idx.close(); }
	});
});
