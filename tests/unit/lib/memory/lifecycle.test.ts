import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMemory, openLifecycle } from "../../../../src/lib/memory/lifecycle.js";
import { readMemoryFile } from "../../../../src/lib/memory/store.js";

let tmp: string;
const repoKey = "lc-test";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-lc-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => { delete process.env.AI_CORTEX_CACHE_HOME; });

describe("createMemory", () => {
	it("writes .md, sqlite row, and vector for an explicit memory; status active, version 1", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "Cache writes",
				body: "## Rule\nuse rename.",
				scope: { files: ["src/lib/cache-store.ts"], tags: ["caching"] },
				source: "explicit",
			});
			expect(id).toMatch(/^mem-\d{4}-\d{2}-\d{2}-cache-writes-[0-9a-f]{6}$/);

			const file = await readMemoryFile(repoKey, id, "memories");
			expect(file.frontmatter.status).toBe("active");
			expect(file.frontmatter.version).toBe(1);
			expect(file.frontmatter.confidence).toBe(1.0);

			const row = lc.index.getMemory(id);
			expect(row?.status).toBe("active");

			const audit = lc.index.auditRows(id);
			expect(audit).toHaveLength(1);
			expect(audit[0].changeType).toBe("create");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("creates as candidate when source=extracted with confidence < 1", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "gotcha",
				title: "Auto-extracted gotcha",
				body: "## Symptom\nx",
				scope: { files: [], tags: [] },
				source: "extracted",
				confidence: 0.55,
				typeFields: { severity: "warning" },
			});
			const file = await readMemoryFile(repoKey, id, "memories");
			expect(file.frontmatter.status).toBe("candidate");
			expect(file.frontmatter.source).toBe("extracted");
			expect(file.frontmatter.confidence).toBe(0.55);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("rejects unregistered types", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await expect(createMemory(lc, {
				type: "rumor",
				title: "x",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			})).rejects.toThrow(/unregistered type/);
		} finally {
			lc.close();
		}
	});

	it("produces unique ids for many same-title same-date creates (retry-on-collision)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const seen = new Set<string>();
			for (let i = 0; i < 5000; i++) {
				const id = await createMemory(lc, {
					type: "decision",
					title: "same title",
					body: "x",
					scope: { files: [], tags: [] },
					source: "explicit",
				});
				expect(seen.has(id)).toBe(false);
				seen.add(id);
			}
			expect(seen.size).toBe(5000);
		} finally {
			lc.close();
		}
	}, 600_000);
});
