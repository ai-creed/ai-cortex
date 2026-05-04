import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
	getMemory,
	listMemories,
	auditMemory,
	searchMemories,
	openRetrieve,
	filterCandidates,
	recallMemory,
} from "../../../../src/lib/memory/retrieve.js";
import {
	openLifecycle,
	createMemory,
} from "../../../../src/lib/memory/lifecycle.js";

let tmp: string;
const repoKey = "72657474657374ff"; // 16-hex fixture

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-ret-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
});

describe("getMemory", () => {
	it("returns full MemoryRecord for an existing memory", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const record = await getMemory(rh, id);
			expect(record.frontmatter.id).toBe(id);
			expect(record.body).toContain("x");
		} finally {
			rh.close();
		}
	}, 30_000);

	it("throws for a missing id", async () => {
		const rh = openRetrieve(repoKey);
		try {
			await expect(getMemory(rh, "mem-nonexistent-x")).rejects.toThrow(
				/not found/,
			);
		} finally {
			rh.close();
		}
	});
});

describe("listMemories", () => {
	it("filters by type", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "D",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "pattern",
				title: "P",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const all = listMemories(rh);
			expect(all).toHaveLength(2);
			const decisions = listMemories(rh, { type: ["decision"] });
			expect(decisions).toHaveLength(1);
			expect(decisions[0].type).toBe("decision");
		} finally {
			rh.close();
		}
	}, 30_000);
});

describe("auditMemory", () => {
	it("returns audit rows in version order", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await import("../../../../src/lib/memory/lifecycle.js").then((m) =>
				m.updateMemory(lc, id, { body: "## Rule\ny", reason: "r" }),
			);
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const rows = auditMemory(rh, id);
			expect(rows).toHaveLength(2);
			expect(rows[0].changeType).toBe("create");
			expect(rows[1].changeType).toBe("update");
		} finally {
			rh.close();
		}
	}, 30_000);
});

describe("searchMemories", () => {
	it("finds memories by full-body content (not just excerpt)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Long decision",
				body: "## Rule\n" + "padding ".repeat(100) + " UNIQUE_FTS_NEEDLE_XYZ",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const hits = searchMemories(rh, "UNIQUE_FTS_NEEDLE_XYZ");
			expect(hits.length).toBeGreaterThan(0);
			expect(hits[0].title).toBe("Long decision");
		} finally {
			rh.close();
		}
	}, 30_000);
});

describe("filterCandidates", () => {
	it("returns all active when no scope filter", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			// project-wide
			await createMemory(lc, {
				type: "decision",
				title: "Global",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			// file-scoped
			await createMemory(lc, {
				type: "decision",
				title: "FileScoped",
				body: "x",
				scope: { files: ["a.ts"], tags: [] },
				source: "explicit",
			});
			// tag-scoped
			await createMemory(lc, {
				type: "decision",
				title: "TagScoped",
				body: "x",
				scope: { files: [], tags: ["linux"] },
				source: "explicit",
			});
			// both-scoped
			await createMemory(lc, {
				type: "decision",
				title: "Both",
				body: "x",
				scope: { files: ["b.ts"], tags: ["caching"] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const all = filterCandidates(rh, { candidatePoolSize: 100 });
			expect(all).toHaveLength(4);
		} finally {
			rh.close();
		}
	}, 30_000);

	it("files-only scope: returns file-scoped + project-wide", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Global",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "decision",
				title: "FileA",
				body: "x",
				scope: { files: ["a.ts"], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "decision",
				title: "TagOnly",
				body: "x",
				scope: { files: [], tags: ["linux"] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const candidates = filterCandidates(rh, {
				scope: { files: ["a.ts"] },
				candidatePoolSize: 100,
			});
			const titles = candidates.map((c) => c.title);
			expect(titles).toContain("Global");
			expect(titles).toContain("FileA");
			expect(titles).not.toContain("TagOnly");
		} finally {
			rh.close();
		}
	}, 30_000);

	it("tags-only scope: returns tag-scoped + project-wide", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Global2",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "decision",
				title: "LinuxTag",
				body: "x",
				scope: { files: [], tags: ["linux"] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "decision",
				title: "FileOnly",
				body: "x",
				scope: { files: ["x.ts"], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const candidates = filterCandidates(rh, {
				scope: { tags: ["linux"] },
				candidatePoolSize: 100,
			});
			const titles = candidates.map((c) => c.title);
			expect(titles).toContain("Global2");
			expect(titles).toContain("LinuxTag");
			expect(titles).not.toContain("FileOnly");
		} finally {
			rh.close();
		}
	}, 30_000);
});

describe("recallMemory", () => {
	it("returns results ordered by score (higher is better)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Atomic writes prevent corruption",
				body: "## Rule\nUse atomic temp-file rename for all writes.",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "gotcha",
				title: "Unrelated gotcha about networking",
				body: "## Symptom\nFails when DNS is slow.",
				scope: { files: [], tags: ["networking"] },
				source: "explicit",
				typeFields: { severity: "warning" },
			});
		} finally {
			lc.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const results = await recallMemory(rh, "how do atomic file writes work");
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].score).toBeGreaterThanOrEqual(0);
			expect(
				results.every((r, i) => i === 0 || results[i - 1].score >= r.score),
			).toBe(true);
		} finally {
			rh.close();
		}
	}, 30_000);

	it("returns empty array for empty store", async () => {
		const rh = openRetrieve(repoKey);
		try {
			const results = await recallMemory(rh, "anything");
			expect(results).toHaveLength(0);
		} finally {
			rh.close();
		}
	});
});
