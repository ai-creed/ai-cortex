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
	listMemoriesPendingRewrite,
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

describe("listMemoriesPendingRewrite", () => {
	it("returns a fresh candidate with no pin / get / re-extract signals", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let bareId: string;
		try {
			bareId = await createMemory(lc, {
				type: "decision",
				title: "bare",
				body: "## Body\nbare",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			const rows = listMemoriesPendingRewrite(rh, { limit: 10 });
			expect(rows.map((r) => r.id)).toContain(bareId);
		} finally {
			rh.close();
		}
	});

	it("excludes a candidate that has been rewritten", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let pendingId: string;
		let rewrittenId: string;
		try {
			pendingId = await createMemory(lc, {
				type: "decision",
				title: "pending",
				body: "## Body\np",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			rewrittenId = await createMemory(lc, {
				type: "decision",
				title: "rewritten",
				body: "## Body\nr",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memories SET rewritten_at='2026-01-01T00:00:00Z' WHERE id=?",
				)
				.run(rewrittenId);
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			const ids = listMemoriesPendingRewrite(rh, { limit: 10 }).map((r) => r.id);
			expect(ids).toContain(pendingId);
			expect(ids).not.toContain(rewrittenId);
		} finally {
			rh.close();
		}
	});

	it("excludes non-candidate statuses (active, deprecated, trashed, merged_into, purged_redacted)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		const ids: string[] = [];
		try {
			const candidateId = await createMemory(lc, {
				type: "decision",
				title: "still candidate",
				body: "## Body\nc",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			ids.push(candidateId);
			const statuses = [
				"active",
				"deprecated",
				"trashed",
				"merged_into",
				"purged_redacted",
			];
			for (const status of statuses) {
				const id = await createMemory(lc, {
					type: "decision",
					title: `s-${status}`,
					body: `## Body\n${status}`,
					scope: { files: [], tags: [] },
					source: "extracted",
				});
				lc.index
					.rawDb()
					.prepare("UPDATE memories SET status=? WHERE id=?")
					.run(status, id);
				ids.push(id);
			}
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			const returned = listMemoriesPendingRewrite(rh, { limit: 50 }).map(
				(r) => r.id,
			);
			expect(returned).toEqual([ids[0]]);
		} finally {
			rh.close();
		}
	});

	it("filters by `since` against updated_at OR last_accessed_at", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let oldId: string;
		let recentId: string;
		let accessedId: string;
		try {
			oldId = await createMemory(lc, {
				type: "decision",
				title: "old",
				body: "## Body\nold",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			recentId = await createMemory(lc, {
				type: "decision",
				title: "recent",
				body: "## Body\nr",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			accessedId = await createMemory(lc, {
				type: "decision",
				title: "old but accessed today",
				body: "## Body\na",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memories SET updated_at='2025-01-01T00:00:00Z', last_accessed_at='2025-01-01T00:00:00Z' WHERE id=?",
				)
				.run(oldId);
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memories SET updated_at='2025-01-01T00:00:00Z' WHERE id=?",
				)
				.run(accessedId);
			lc.index.bumpGetCount(accessedId);
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			const ids = listMemoriesPendingRewrite(rh, {
				since: "2026-01-01T00:00:00Z",
				limit: 10,
			}).map((r) => r.id);
			expect(ids).toContain(recentId);
			expect(ids).toContain(accessedId);
			expect(ids).not.toContain(oldId);
		} finally {
			rh.close();
		}
	});

	it("caps the returned page at the `limit` argument", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			for (let i = 0; i < 12; i++) {
				await createMemory(lc, {
					type: "decision",
					title: `c${i}`,
					body: `## Body\n${i}`,
					scope: { files: [], tags: [] },
					source: "extracted",
				});
			}
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			const rows = listMemoriesPendingRewrite(rh, { limit: 5 });
			expect(rows).toHaveLength(5);
		} finally {
			rh.close();
		}
	});

	it("orders by confidence DESC within a returned page", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let lowId: string;
		let midId: string;
		let highId: string;
		try {
			lowId = await createMemory(lc, {
				type: "decision",
				title: "low",
				body: "## Body\nl",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			midId = await createMemory(lc, {
				type: "decision",
				title: "mid",
				body: "## Body\nm",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			highId = await createMemory(lc, {
				type: "decision",
				title: "high",
				body: "## Body\nh",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			const db = lc.index.rawDb();
			db.prepare("UPDATE memories SET confidence=0.30 WHERE id=?").run(lowId);
			db.prepare("UPDATE memories SET confidence=0.60 WHERE id=?").run(midId);
			db.prepare("UPDATE memories SET confidence=0.90 WHERE id=?").run(highId);
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			const ordered = listMemoriesPendingRewrite(rh, { limit: 10 }).map(
				(r) => r.id,
			);
			const idxHigh = ordered.indexOf(highId);
			const idxMid = ordered.indexOf(midId);
			const idxLow = ordered.indexOf(lowId);
			expect(idxHigh).toBeGreaterThanOrEqual(0);
			expect(idxHigh).toBeLessThan(idxMid);
			expect(idxMid).toBeLessThan(idxLow);
		} finally {
			rh.close();
		}
	});
});
