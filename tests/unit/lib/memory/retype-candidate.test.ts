import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
	openLifecycle,
	createMemory,
	retypeCandidate,
	rewriteMemory,
} from "../../../../src/lib/memory/lifecycle.js";
import { readMemoryFile } from "../../../../src/lib/memory/store.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("retype-candidate");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

describe("retypeCandidate", () => {
	it("retypes a candidate, resets typeFields, preserves status/body", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "gotcha",
				title: "vec dim mismatch",
				body: "Symptom: crash. Cause: model swap.",
				scope: { files: [], tags: [] },
				source: "extracted",
				typeFields: { severity: "warning" },
			});
			await retypeCandidate(lc, id, "capture");
			const row = lc.index.getMemory(id)!;
			expect(row.type).toBe("capture");
			expect(row.status).toBe("candidate");
			const rec = await readMemoryFile(repoKey, id, "memories");
			expect(rec.frontmatter.typeFields ?? {}).toEqual({});
			expect(rec.body).toContain("Symptom: crash");
			// later rewrite to decision omitting typeFields stays clean
			await rewriteMemory(lc, id, {
				title: "vec dim mismatch",
				body: "Rule: rebuild index after model swap.",
				scopeFiles: [],
				scopeTags: [],
				type: "decision",
			});
			const rec2 = await readMemoryFile(repoKey, id, "memories");
			expect(rec2.frontmatter.typeFields ?? {}).toEqual({});
			expect(rec2.frontmatter.status).toBe("active");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("throws on a non-candidate", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "explicit",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit", // → status active
			});
			await expect(retypeCandidate(lc, id, "capture")).rejects.toThrow(
				/candidate/i,
			);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("validates the target type against the registry", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "gotcha",
				title: "t",
				body: "Symptom: s",
				scope: { files: [], tags: [] },
				source: "extracted",
				typeFields: { severity: "info" },
			});
			await expect(
				retypeCandidate(lc, id, "no-such-type"),
			).rejects.toThrow(/unregistered type|validation/i);
		} finally {
			lc.close();
		}
	}, 30_000);
});
