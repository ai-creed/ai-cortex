import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
	openLifecycle,
	createMemory,
	confirmMemory,
	rewriteMemory,
} from "../../../../src/lib/memory/lifecycle.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("confirm-capture-guard");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

describe("confirmMemory capture guard", () => {
	it("refuses to promote a type:'capture' candidate (no active+capture)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "capture",
				title: "unjudged",
				body: "always run tests before commit",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			await expect(confirmMemory(lc, id)).rejects.toThrow(
				/capture.*rewrite_?[Mm]emory/s,
			);
			// still a candidate, still capture — invariant intact
			const row = lc.index.getMemory(id)!;
			expect(row.status).toBe("candidate");
			expect(row.type).toBe("capture");
		} finally {
			lc.close();
		}
	});

	it("rewriteMemory remains the valid keep path for a capture candidate", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "capture",
				title: "unjudged",
				body: "always run tests before commit",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			await rewriteMemory(lc, id, {
				title: "always run tests before commit",
				body: "Rule: run the test suite before every commit.",
				scopeFiles: [],
				scopeTags: [],
				type: "decision",
			});
			const row = lc.index.getMemory(id)!;
			expect(row.status).toBe("active");
			expect(row.type).toBe("decision");
		} finally {
			lc.close();
		}
	});

	it("still confirms a normally-typed candidate (guard is capture-only)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "typed candidate",
				body: "Rule: x.",
				scope: { files: [], tags: [] },
				source: "extracted", // → candidate
			});
			await confirmMemory(lc, id);
			const row = lc.index.getMemory(id)!;
			expect(row.status).toBe("active");
			expect(row.type).toBe("decision");
		} finally {
			lc.close();
		}
	});
});
