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
		const capturesIdx = md!.indexOf("## Captures pending confirmation");
		const howIdx = md!.indexOf("### How to consult");
		expect(capturesIdx).toBeGreaterThanOrEqual(0);
		expect(howIdx).toBeGreaterThan(capturesIdx);
	});

	it("counts only high-tier captures and discloses the low tier", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "capture", title: "high",
				body: "always run pnpm build before tagging",
				scope: { files: [], tags: [] }, source: "extracted",
			});
			await createMemory(lc, {
				type: "capture", title: "low",
				body: "push it and prepare a new patch release",
				scope: { files: [], tags: [] }, source: "extracted",
			});
		} finally {
			lc.close();
		}
		const md = await renderMemoryDigest(repoKey);
		expect(md!).toMatch(/## Captures pending confirmation — 1 \(\+1 low-signal, auto-expiring\)/);
		expect(md!).toContain("dispatch `review_pending_captures` now");
	});

	it("excludes captures from the generic Pending review section", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "capture", title: "cap",
				body: "always run pnpm build before tagging",
				scope: { files: [], tags: [] }, source: "extracted",
			});
		} finally {
			lc.close();
		}
		const md = await renderMemoryDigest(repoKey);
		expect(md!).toContain("## Captures pending confirmation");
		expect(md!).not.toContain("## Pending review");
	});

	it("keeps non-capture extracted candidates in Pending review and out of the captures section", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "decision", title: "legacy extracted decision",
				body: "always do X because Y",
				scope: { files: [], tags: [] }, source: "extracted",
			});
		} finally {
			lc.close();
		}
		const md = await renderMemoryDigest(repoKey);
		expect(md!).toContain("## Pending review — 1");
		expect(md!).not.toContain("## Captures pending confirmation");
	});
});
