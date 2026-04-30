import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
	createMemory,
	openLifecycle,
	updateMemory,
	updateScope,
	deprecateMemory,
	restoreMemory,
	mergeMemories,
	trashMemory,
	untrashMemory,
	purgeMemory,
	linkMemories,
	unlinkMemories,
	pinMemory,
	unpinMemory,
	confirmMemory,
	addEvidence,
	bumpConfidence,
} from "../../../../src/lib/memory/lifecycle.js";
import { readMemoryFile } from "../../../../src/lib/memory/store.js";
import { memoryFilePath } from "../../../../src/lib/memory/paths.js";

let tmp: string;
const repoKey = "lc-test";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-lc-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
});

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
			await expect(
				createMemory(lc, {
					type: "rumor",
					title: "x",
					body: "x",
					scope: { files: [], tags: [] },
					source: "explicit",
				}),
			).rejects.toThrow(/unregistered type/);
		} finally {
			lc.close();
		}
	});

	it("produces unique ids for many same-title same-date creates (retry-on-collision)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const seen = new Set<string>();
			// 300 creates: proves uniqueness under repeated same-title/same-date collisions
			// without the O(n²) vector sidecar rebuild cost of 5000 iterations
			for (let i = 0; i < 300; i++) {
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
			expect(seen.size).toBe(300);
		} finally {
			lc.close();
		}
	}, 60_000);
});

describe("updateMemory", () => {
	it("bumps version, refreshes updatedAt, appends audit; preserves prev_body_hash", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\noriginal",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			const beforeRow = lc.index.getMemory(id)!;

			await updateMemory(lc, id, {
				body: "## Rule\nupdated",
				reason: "refined",
			});
			const afterRow = lc.index.getMemory(id)!;
			expect(afterRow.version).toBe(2);
			expect(afterRow.body_hash).not.toBe(beforeRow.body_hash);

			const audit = lc.index.auditRows(id);
			expect(audit).toHaveLength(2);
			expect(audit[1].changeType).toBe("update");
			expect(audit[1].prevBodyHash).toBe(beforeRow.body_hash);
			expect(audit[1].reason).toBe("refined");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("stores prev_body when type opts in (decision auditPreserveBody=true)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\noriginal",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await updateMemory(lc, id, { body: "## Rule\nupdated", reason: "x" });
			const audit = lc.index.auditRows(id);
			expect(audit[1].prevBody).toContain("original");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("does NOT store prev_body when type opts out (pattern auditPreserveBody not set)", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "pattern",
				title: "T",
				body: "## Where\nfile.ts",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await updateMemory(lc, id, { body: "## Where\nother.ts", reason: "x" });
			const audit = lc.index.auditRows(id);
			expect(audit[1].prevBody).toBeNull();
		} finally {
			lc.close();
		}
	}, 30_000);
});

describe("updateScope", () => {
	it("replaces scope and records audit row 'scope_change'", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: ["a.ts"], tags: [] },
				source: "explicit",
			});
			await updateScope(lc, id, { files: ["b.ts"], tags: ["t"] });
			expect(lc.index.scopeRows(id)).toEqual([
				{ kind: "file", value: "b.ts" },
				{ kind: "tag", value: "t" },
			]);
			const audit = lc.index.auditRows(id);
			expect(audit.at(-1)!.changeType).toBe("scope_change");
		} finally {
			lc.close();
		}
	}, 30_000);
});

describe("deprecateMemory / restoreMemory", () => {
	it("flips active → deprecated with reason; restore reverses to active", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await deprecateMemory(lc, id, "no longer applies");
			expect(lc.index.getMemory(id)!.status).toBe("deprecated");

			await restoreMemory(lc, id);
			expect(lc.index.getMemory(id)!.status).toBe("active");

			const audit = lc.index.auditRows(id);
			expect(audit.map((a) => a.changeType)).toEqual([
				"create",
				"deprecate",
				"restore",
			]);
		} finally {
			lc.close();
		}
	}, 30_000);

	it("restoreMemory only works from deprecated, not from merged_into", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			lc.index
				.rawDb()
				.prepare("UPDATE memories SET status='merged_into' WHERE id=?")
				.run(id);
			await expect(restoreMemory(lc, id)).rejects.toThrow(
				/only from deprecated/,
			);
		} finally {
			lc.close();
		}
	});
});

describe("mergeMemories", () => {
	it("flips src to merged_into, points mergedInto at dst, replaces dst body", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const a = await createMemory(lc, {
				type: "decision",
				title: "A",
				body: "## Rule\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			const b = await createMemory(lc, {
				type: "decision",
				title: "B",
				body: "## Rule\nb",
				scope: { files: [], tags: [] },
				source: "explicit",
			});

			await mergeMemories(lc, a, b, "## Rule\nmerged a+b");

			expect(lc.index.getMemory(a)!.status).toBe("merged_into");
			const fileA = await readMemoryFile(repoKey, a, "memories");
			expect(fileA.frontmatter.mergedInto).toBe(b);

			expect(lc.index.getMemory(b)!.status).toBe("active");
			const fileB = await readMemoryFile(repoKey, b, "memories");
			expect(fileB.body).toBe("## Rule\nmerged a+b");

			expect(lc.index.auditRows(a).at(-1)!.changeType).toBe("merge");
			expect(lc.index.auditRows(b).at(-1)!.changeType).toBe("merge");
		} finally {
			lc.close();
		}
	}, 30_000);
});

describe("trashMemory / untrashMemory", () => {
	it("moves file to trash/, flips status to trashed, records audit", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await trashMemory(lc, id, "no longer relevant");

			expect(lc.index.getMemory(id)!.status).toBe("trashed");
			const trashed = await fs
				.access(memoryFilePath(repoKey, id, "trash"))
				.then(() => true)
				.catch(() => false);
			const stillInMemories = await fs
				.access(memoryFilePath(repoKey, id, "memories"))
				.then(() => true)
				.catch(() => false);
			expect(trashed).toBe(true);
			expect(stillInMemories).toBe(false);

			expect(lc.index.auditRows(id).at(-1)!.changeType).toBe("trash");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("untrashMemory restores file to memories/ and flips status back to active", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await trashMemory(lc, id, "x");
			await untrashMemory(lc, id);

			expect(lc.index.getMemory(id)!.status).toBe("active");
			const restored = await fs
				.access(memoryFilePath(repoKey, id, "memories"))
				.then(() => true)
				.catch(() => false);
			expect(restored).toBe(true);

			expect(lc.index.auditRows(id).at(-1)!.changeType).toBe("untrash");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("rejects untrashMemory when memory is not in trashed state", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await expect(untrashMemory(lc, id)).rejects.toThrow(/only from trashed/);
		} finally {
			lc.close();
		}
	});
});

describe("purgeMemory (default)", () => {
	it("hard-deletes the .md, removes FTS, leaves audit + memories row", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await purgeMemory(lc, id, "no longer needed");
			await expect(readMemoryFile(repoKey, id, "memories")).rejects.toThrow();
			const audit = lc.index.auditRows(id);
			expect(audit.map((a) => a.changeType)).toContain("purge");
		} finally {
			lc.close();
		}
	});
});

describe("purgeMemory (redact)", () => {
	it("scrubs title + body_excerpt, nulls audit prev_body, removes FTS + vector", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "Sensitive decision",
				body: "## Rule\nsecret",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await purgeMemory(lc, id, "privacy", { redact: true });

			const row = lc.index.getMemory(id);
			expect(row?.status).toBe("purged_redacted");
			expect(row?.title).toBe("<redacted>");
			expect(row?.body_excerpt).toBe("<redacted>");

			const audit = lc.index.auditRows(id);
			const redactEntry = audit.find((a) => a.changeType === "purge_redact");
			expect(redactEntry).toBeDefined();
		} finally {
			lc.close();
		}
	});

	it("merge case: redact src only; dst body unchanged", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const a = await createMemory(lc, {
				type: "decision",
				title: "A",
				body: "## Rule\na-secret",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			const b = await createMemory(lc, {
				type: "decision",
				title: "B",
				body: "## Rule\nb-public",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await mergeMemories(lc, a, b, "## Rule\nmerged");
			await purgeMemory(lc, a, "privacy", { redact: true });

			const rowA = lc.index.getMemory(a);
			expect(rowA?.status).toBe("purged_redacted");
			const fileB = await readMemoryFile(repoKey, b, "memories");
			expect(fileB.body).toContain("merged");
		} finally {
			lc.close();
		}
	}, 30_000);
});

describe("linkMemories / unlinkMemories", () => {
	it("creates a typed edge and removes it; audit rows recorded", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const a = await createMemory(lc, {
				type: "decision",
				title: "A",
				body: "## Rule\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			const b = await createMemory(lc, {
				type: "decision",
				title: "B",
				body: "## Rule\nb",
				scope: { files: [], tags: [] },
				source: "explicit",
			});

			await linkMemories(lc, a, b, "supports");
			expect(lc.index.linksFrom(a)).toEqual([
				expect.objectContaining({ srcId: a, dstId: b, relType: "supports" }),
			]);
			expect(lc.index.auditRows(a).at(-1)!.changeType).toBe("link_add");

			await unlinkMemories(lc, a, b, "supports");
			expect(lc.index.linksFrom(a)).toHaveLength(0);
			expect(lc.index.auditRows(a).at(-1)!.changeType).toBe("link_remove");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("rejects self-links", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const a = await createMemory(lc, {
				type: "decision",
				title: "A",
				body: "## Rule\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await expect(linkMemories(lc, a, a, "supports")).rejects.toThrow(/self/);
		} finally {
			lc.close();
		}
	});

	it("rejects unknown rel types", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const a = await createMemory(lc, {
				type: "decision",
				title: "A",
				body: "## Rule\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			const b = await createMemory(lc, {
				type: "decision",
				title: "B",
				body: "## Rule\nb",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await expect(linkMemories(lc, a, b, "ohno" as any)).rejects.toThrow(
				/rel.*type/i,
			);
		} finally {
			lc.close();
		}
	});

	it("rejects edges referencing missing memories", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const a = await createMemory(lc, {
				type: "decision",
				title: "A",
				body: "## Rule\na",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await expect(
				linkMemories(lc, a, "mem-fake-x", "supports"),
			).rejects.toThrow(/not found/);
		} finally {
			lc.close();
		}
	});
});

describe("pinMemory / unpinMemory", () => {
	it("flips pinned in sqlite, frontmatter, and audit", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await pinMemory(lc, id);
			expect(lc.index.getMemory(id)!.pinned).toBe(1);
			expect(lc.index.auditRows(id).at(-1)!.changeType).toBe("pin");

			await unpinMemory(lc, id);
			expect(lc.index.getMemory(id)!.pinned).toBe(0);
			expect(lc.index.auditRows(id).at(-1)!.changeType).toBe("unpin");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("respects pinnedHardCap; force flag bypasses", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const ids: string[] = [];
			for (let i = 0; i < 21; i++) {
				ids.push(
					await createMemory(lc, {
						type: "decision",
						title: `T${i}`,
						body: "## Rule\nx",
						scope: { files: [], tags: [] },
						source: "explicit",
					}),
				);
			}
			for (let i = 0; i < 20; i++) await pinMemory(lc, ids[i]!);
			await expect(pinMemory(lc, ids[20]!)).rejects.toThrow(/cap/i);
			await pinMemory(lc, ids[20]!, { force: true });
			expect(lc.index.getMemory(ids[20]!)!.pinned).toBe(1);
		} finally {
			lc.close();
		}
	}, 60_000);
});

describe("confirmMemory", () => {
	it("flips candidate → active and confidence → 1.0; audit 'promote'", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "gotcha",
				title: "G",
				body: "## Symptom\nx",
				scope: { files: [], tags: [] },
				source: "extracted",
				confidence: 0.55,
				typeFields: { severity: "warning" },
			});
			expect(lc.index.getMemory(id)!.status).toBe("candidate");

			await confirmMemory(lc, id);
			const row = lc.index.getMemory(id)!;
			expect(row.status).toBe("active");
			expect(row.confidence).toBe(1.0);
			expect(lc.index.auditRows(id).at(-1)!.changeType).toBe("promote");
		} finally {
			lc.close();
		}
	}, 30_000);

	it("rejects from non-candidate states", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await expect(confirmMemory(lc, id)).rejects.toThrow(
				/only from candidate/,
			);
		} finally {
			lc.close();
		}
	});
});

describe("addEvidence", () => {
	it("appends a provenance entry to the memory's frontmatter and bumps version", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const id = await createMemory(lc, {
				type: "decision",
				title: "T",
				body: "## Rule\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await addEvidence(lc, id, {
				sessionId: "s-2026-04-30-abcd",
				turn: 7,
				kind: "user_correction",
				excerpt: "we agreed on rename",
			});

			const file = await readMemoryFile(repoKey, id, "memories");
			expect(file.frontmatter.provenance).toHaveLength(1);
			expect(file.frontmatter.provenance[0]!.sessionId).toBe(
				"s-2026-04-30-abcd",
			);
			expect(file.frontmatter.version).toBe(2);
			expect(lc.index.auditRows(id).at(-1)!.changeType).toBe("update");
		} finally {
			lc.close();
		}
	}, 30_000);
});

describe("bumpConfidence", () => {
	it("bumpConfidence raises confidence and caps at 0.95", async () => {
		const lc = await openLifecycle(repoKey);
		const id = await createMemory(lc, {
			type: "decision", title: "T", body: "B",
			scope: { files: [], tags: [] },
			source: "extracted",
			confidence: 0.5,
		});
		expect(await bumpConfidence(lc, id, 0.10, "test")).toBeCloseTo(0.60, 2);
		expect(await bumpConfidence(lc, id, 0.40, "test")).toBeCloseTo(0.95, 2);
		expect(await bumpConfidence(lc, id, 0.10, "test")).toBeCloseTo(0.95, 2);
		lc.close();
	}, 30_000);
});
