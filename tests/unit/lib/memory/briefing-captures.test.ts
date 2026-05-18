import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { renderMemoryDigest } from "../../../../src/lib/memory/briefing-digest.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("briefing captures section", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("briefing-captures");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("shows the section iff there are pending captures", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			let md = await renderMemoryDigest(repoKey);
			expect(md ?? "").not.toContain("Captures pending confirmation");
			await createMemory(lc, {
				type: "capture",
				title: "cap1",
				body: "always run tests",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			md = await renderMemoryDigest(repoKey);
			expect(md).not.toBeNull();
			expect(md!).toMatch(/## Captures pending confirmation — 1/);
			expect(md!).toContain("review_pending_captures");
			expect(md!).toContain("rewrite_memory");
			expect(md!).toContain("deprecate_memory");
			expect(md!).toContain("Never `confirm_memory` on a `capture` row");
		} finally {
			lc.close();
		}
	});

	it("keeps the captures section separate from and after the cleanup section, before How to consult", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "decision",
				title: "active rule",
				body: "## Body\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "capture",
				title: "cap1",
				body: "always run tests before commit",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
		} finally {
			lc.close();
		}
		const md = await renderMemoryDigest(repoKey);
		expect(md).not.toBeNull();
		const cleanupIdx = md!.indexOf("## Pending review");
		const capturesIdx = md!.indexOf("## Captures pending confirmation");
		const howIdx = md!.indexOf("### How to consult");
		expect(cleanupIdx).toBeGreaterThanOrEqual(0);
		expect(capturesIdx).toBeGreaterThan(cleanupIdx);
		expect(howIdx).toBeGreaterThan(capturesIdx);
	});
});
