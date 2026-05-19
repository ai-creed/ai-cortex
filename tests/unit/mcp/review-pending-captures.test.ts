import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openLifecycle, createMemory } from "../../../src/lib/memory/lifecycle.js";
import { reviewPendingCaptures } from "../../../src/lib/memory/pending-captures.js";
import { mkRepoKey, cleanupRepo } from "../../helpers/memory-fixtures.js";

// This is a thin MCP wrapper; the heavy logic is unit-tested in Task 7.
// Assert the reader is callable and returns the PendingCapture[] contract the
// tool serializes. End-to-end registration is proven by the server-level
// integration test (tests/integration/review-pending-captures-mcp.test.ts).
describe("review_pending_captures contract", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("mcp-cap");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("reader returns the documented shape", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "capture",
				title: "always X",
				body: "always do X because Y",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			const out = await reviewPendingCaptures(repoKey, { limit: 5 });
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({
				title: "always X",
				signalScore: expect.any(Number),
				context: { kind: expect.any(String) },
			});
		} finally {
			lc.close();
		}
	});
});
