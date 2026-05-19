// tests/integration/legacy-capture-triage.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { readMemoryFile } from "../../src/lib/memory/store.js";
import { runCaptureTriageIfNeeded } from "../../src/lib/memory/capture-triage.js";

let repoKey: string;

beforeEach(async () => {
	repoKey = await mkRepoKey("legacy-capture-triage");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

describe("legacy capture triage", () => {
	it("deprecates structural noise, retypes signal-bearing survivors to capture, idempotent", async () => {
		const lc = await openLifecycle(repoKey);
		let noiseId: string;
		let keepId: string;
		try {
			noiseId = await createMemory(lc, {
				type: "decision",
				title: "ok good",
				body: "Should be good. Let's write plan.",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			keepId = await createMemory(lc, {
				type: "gotcha",
				title: "agnostic id",
				body: "CLAUDE_SESSION_ID is too specific to claude. Make it agnostic; Codex sends one too.",
				scope: { files: [], tags: [] },
				source: "extracted",
				typeFields: { severity: "warning" },
			});
		} finally {
			lc.close();
		}

		await runCaptureTriageIfNeeded(repoKey);

		const lc2 = await openLifecycle(repoKey);
		try {
			const noise = lc2.index.getMemory(noiseId)!;
			const keep = lc2.index.getMemory(keepId)!;
			expect(noise.status).toBe("deprecated");
			expect(keep.status).toBe("candidate");
			expect(keep.type).toBe("capture");
			const rec = await readMemoryFile(repoKey, keepId, "memories");
			expect(rec.frontmatter.typeFields ?? {}).toEqual({}); // severity dropped
		} finally {
			lc2.close();
		}

		// idempotent — second run is a no-op (sentinel)
		await runCaptureTriageIfNeeded(repoKey);
		const lc3 = await openLifecycle(repoKey);
		try {
			expect(lc3.index.getMemory(keepId)!.version).toBeLessThanOrEqual(3);
		} finally {
			lc3.close();
		}
	});
});
