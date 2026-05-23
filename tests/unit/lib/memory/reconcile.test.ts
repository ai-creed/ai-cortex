import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { reconcileStore } from "../../../../src/lib/memory/reconcile.js";
import {
	openLifecycle,
	createMemory,
} from "../../../../src/lib/memory/lifecycle.js";
import { writeMemoryFile } from "../../../../src/lib/memory/store.js";
import { memoriesDir, trashDir } from "../../../../src/lib/memory/paths.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import { serializeMemoryMarkdown } from "../../../../src/lib/memory/markdown.js";
import type { MemoryRecord } from "../../../../src/lib/memory/types.js";

let tmp: string;
const repoKey = "7265636f6e746573"; // 16-hex fixture

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-recon-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
});

function makeRecord(id: string): MemoryRecord {
	return {
		frontmatter: {
			id,
			type: "decision",
			status: "active",
			title: "T",
			version: 1,
			createdAt: "2026-04-30T00:00:00.000Z",
			updatedAt: "2026-04-30T00:00:00.000Z",
			source: "explicit",
			confidence: 1,
			pinned: false,
			scope: { files: [], tags: [] },
			provenance: [],
			supersedes: [],
			mergedInto: null,
			deprecationReason: null,
			promotedFrom: [],
			rewrittenAt: null,
		},
		body: "## Rule\ntest body",
	};
}

describe("reconcileStore", () => {
	it("adopts orphan .md files (no sqlite row)", async () => {
		// Write .md directly without going through lifecycle
		const r = makeRecord("mem-2026-04-30-orphan-aaa111");
		await writeMemoryFile(repoKey, r);

		const report = await reconcileStore(repoKey);
		expect(report.adopted).toContain("mem-2026-04-30-orphan-aaa111");
		expect(report.reindexed).toHaveLength(0);
		expect(report.phantomsRemoved).toHaveLength(0);

		// Row should now exist in sqlite
		const idx = openMemoryIndex(repoKey);
		expect(idx.getMemory("mem-2026-04-30-orphan-aaa111")).toBeDefined();
		const audit = idx.auditRows("mem-2026-04-30-orphan-aaa111");
		expect(
			audit.some(
				(a) => a.changeType === "reconcile" && a.reason === "adopted from disk",
			),
		).toBe(true);
		idx.close();
	}, 30_000);

	it("removes phantom sqlite rows (no .md file, non-terminal status)", async () => {
		// Insert a sqlite row without a corresponding .md file
		const idx = openMemoryIndex(repoKey);
		const phantomId = "mem-2026-04-30-phantom-bbb222";
		idx.upsertMemory(
			{
				id: phantomId,
				type: "decision",
				status: "active",
				title: "Phantom",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			{ bodyHash: "fakehash", bodyExcerpt: "x", body: "x" },
		);
		idx.close();

		const report = await reconcileStore(repoKey);
		expect(report.phantomsRemoved).toContain(phantomId);

		const idx2 = openMemoryIndex(repoKey);
		expect(idx2.getMemory(phantomId)).toBeUndefined();
		idx2.close();
	}, 30_000);

	it("re-indexes when body-hash drifts", async () => {
		// Create memory normally
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "Drifted",
				body: "## Rule\noriginal",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		// Directly modify the .md file without updating sqlite (simulates drift)
		const mdPath = path.join(memoriesDir(repoKey), `${id}.md`);
		const text = await fs.readFile(mdPath, "utf8");
		await fs.writeFile(mdPath, text.replace("original", "modified"));

		const report = await reconcileStore(repoKey);
		expect(report.reindexed).toContain(id);

		// Verify hash was updated
		const idx = openMemoryIndex(repoKey);
		const row = idx.getMemory(id);
		const newHash = crypto
			.createHash("sha256")
			.update("Drifted")
			.update("\n\n")
			.update("## Rule\nmodified")
			.digest("hex");
		expect(row?.body_hash).toBe(newHash);
		idx.close();
	}, 30_000);

	it("returns legacyRepaired in the report shape", async () => {
		const report = await reconcileStore(repoKey);
		expect(report).toEqual(
			expect.objectContaining({
				adopted: expect.any(Array),
				reindexed: expect.any(Array),
				phantomsRemoved: expect.any(Array),
				legacyRepaired: expect.any(Array),
			}),
		);
	});

	it("repairs and adopts a legacy-shaped orphan: scope merged into frontmatter, body stripped, audit reason 'legacy scope normalized'", async () => {
		const id = "mem-2026-04-30-legacy-adopt-aaa111";
		const legacyBody =
			"## Rule\nUse strictEqual.\n\n" +
			'<scopeFiles>["**/*.app-test.ts", "Test/src/**/*.ts"]</scopeFiles>\n' +
			'<scopeTags>["unit-tests", "assertions"]</scopeTags>\n' +
			"<source>explicit</source>\n" +
			"<confidence>1</confidence>\n" +
			"<globalScope>false</globalScope>\n" +
			"</invoke>\n";
		const r: MemoryRecord = {
			frontmatter: {
				id,
				type: "decision",
				status: "active",
				title: "T",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: legacyBody,
		};
		await writeMemoryFile(repoKey, r);

		const report = await reconcileStore(repoKey);
		expect(report.adopted).toContain(id);
		expect(report.legacyRepaired).toContain(id);

		// File on disk is now canonical
		const onDisk = await fs.readFile(
			path.join(memoriesDir(repoKey), `${id}.md`),
			"utf8",
		);
		expect(onDisk).not.toMatch(/<scopeFiles>/);
		expect(onDisk).not.toMatch(/<scopeTags>/);
		expect(onDisk).not.toMatch(/<\/invoke>/);
		expect(onDisk).toMatch(
			/scope:\s*\n\s*files:\s*\n\s*-\s*"?\*\*\/\*\.app-test\.ts"?/,
		);
		expect(onDisk).toMatch(/version:\s*2/);

		// memory_scope rows are populated
		const idx = openMemoryIndex(repoKey);
		const scopes = idx.scopeRows(id);
		expect(scopes.filter((s) => s.kind === "file").map((s) => s.value)).toEqual(
			expect.arrayContaining(["**/*.app-test.ts", "Test/src/**/*.ts"]),
		);
		expect(scopes.filter((s) => s.kind === "tag").map((s) => s.value)).toEqual(
			expect.arrayContaining(["unit-tests", "assertions"]),
		);

		// Audit row has the legacy-repair reason
		const audit = idx.auditRows(id);
		expect(
			audit.some(
				(a) =>
					a.changeType === "reconcile" &&
					a.reason !== null &&
					a.reason.includes("legacy scope normalized"),
			),
		).toBe(true);
		idx.close();
	}, 30_000);

	it("repairs an already-indexed legacy file via the drift branch", async () => {
		const id = "mem-2026-04-30-legacy-drift-bbb222";
		const legacyBody =
			"## Rule\nbody.\n\n" +
			'<scopeFiles>["a.ts"]</scopeFiles>\n' +
			'<scopeTags>["t1"]</scopeTags>\n';
		const r: MemoryRecord = {
			frontmatter: {
				id,
				type: "decision",
				status: "active",
				title: "T",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: legacyBody,
		};
		await writeMemoryFile(repoKey, r);

		// First pass: legacy is adopted-and-repaired.
		const first = await reconcileStore(repoKey);
		expect(first.legacyRepaired).toContain(id);

		// Re-introduce drift by rewriting the file with a stale legacy shape AGAIN.
		// (Simulates the realistic case where an indexed memory file still carries
		// the legacy shape on disk because the agent rewrote it later.)
		await writeMemoryFile(repoKey, {
			...r,
			frontmatter: { ...r.frontmatter, version: 2 },
		});

		const second = await reconcileStore(repoKey);
		expect(second.reindexed).toContain(id);
		expect(second.legacyRepaired).toContain(id);

		const idx = openMemoryIndex(repoKey);
		const scopes = idx.scopeRows(id);
		expect(scopes.filter((s) => s.kind === "file").map((s) => s.value)).toEqual(
			["a.ts"],
		);
		const audit = idx.auditRows(id);
		expect(
			audit.some(
				(a) =>
					a.changeType === "reconcile" &&
					a.reason === "legacy scope normalized",
			),
		).toBe(true);
		idx.close();
	}, 30_000);

	it("preserves existing frontmatter scope when body trailer is also present (strip-only)", async () => {
		const id = "mem-2026-04-30-legacy-merge-ccc333";
		const legacyBody =
			"## Rule\nbody.\n\n" + '<scopeFiles>["from-body.ts"]</scopeFiles>\n';
		const r: MemoryRecord = {
			frontmatter: {
				id,
				type: "decision",
				status: "active",
				title: "T",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: ["from-frontmatter.ts"], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: legacyBody,
		};
		await writeMemoryFile(repoKey, r);

		const report = await reconcileStore(repoKey);
		expect(report.legacyRepaired).toContain(id);

		const idx = openMemoryIndex(repoKey);
		const scopes = idx.scopeRows(id);
		// Frontmatter wins: file scope is unchanged, body fragment is discarded.
		expect(scopes.filter((s) => s.kind === "file").map((s) => s.value)).toEqual(
			["from-frontmatter.ts"],
		);
		idx.close();

		const onDisk = await fs.readFile(
			path.join(memoriesDir(repoKey), `${id}.md`),
			"utf8",
		);
		expect(onDisk).not.toMatch(/<scopeFiles>/);
	}, 30_000);

	it("is idempotent: second reconcile pass does not re-repair a canonicalized file", async () => {
		const id = "mem-2026-04-30-legacy-idem-ddd444";
		const legacyBody =
			"## Rule\nbody.\n\n" + '<scopeFiles>["x.ts"]</scopeFiles>\n';
		await writeMemoryFile(repoKey, {
			frontmatter: {
				id,
				type: "decision",
				status: "active",
				title: "T",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: legacyBody,
		});

		const first = await reconcileStore(repoKey);
		expect(first.legacyRepaired).toContain(id);

		const second = await reconcileStore(repoKey);
		expect(second.legacyRepaired).not.toContain(id);
		expect(second.adopted).not.toContain(id);
		expect(second.reindexed).not.toContain(id);
	}, 30_000);

	it("does not throw and still strips trailer when payload JSON is malformed", async () => {
		const id = "mem-2026-04-30-legacy-malformed-eee555";
		const legacyBody =
			"## Rule\nbody.\n\n" + "<scopeFiles>{not valid</scopeFiles>\n";
		await writeMemoryFile(repoKey, {
			frontmatter: {
				id,
				type: "decision",
				status: "active",
				title: "T",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: legacyBody,
		});

		const report = await reconcileStore(repoKey);
		// Repair still fires (trailer stripped) but no scope is recovered.
		expect(report.legacyRepaired).toContain(id);

		const onDisk = await fs.readFile(
			path.join(memoriesDir(repoKey), `${id}.md`),
			"utf8",
		);
		expect(onDisk).not.toMatch(/<scopeFiles>/);

		const idx = openMemoryIndex(repoKey);
		const scopes = idx.scopeRows(id);
		expect(scopes).toHaveLength(0);
		idx.close();
	}, 30_000);

	it("does not repair a legacy-shaped file in trash/", async () => {
		const id = "mem-2026-04-30-legacy-trash-fff666";
		const legacyBody =
			"## Rule\nbody.\n\n" +
			'<scopeFiles>["a.ts"]</scopeFiles>\n' +
			'<scopeTags>["t1"]</scopeTags>\n';
		const record: MemoryRecord = {
			frontmatter: {
				id,
				type: "decision",
				status: "trashed",
				title: "T",
				version: 1,
				createdAt: "2026-04-30T00:00:00.000Z",
				updatedAt: "2026-04-30T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: legacyBody,
		};

		// Hand-write the file directly into trashDir to bypass the normal
		// write-then-move-to-trash lifecycle (which would invoke other code paths).
		await fs.mkdir(trashDir(repoKey), { recursive: true });
		const trashPath = path.join(trashDir(repoKey), `${id}.md`);
		await fs.writeFile(trashPath, serializeMemoryMarkdown(record), "utf8");

		const before = await fs.readFile(trashPath, "utf8");
		const report = await reconcileStore(repoKey);

		// Trashed file must NOT appear in legacyRepaired.
		expect(report.legacyRepaired).not.toContain(id);

		// File on disk must be byte-identical to before reconcile.
		const after = await fs.readFile(trashPath, "utf8");
		expect(after).toBe(before);

		// File must NOT have been moved into memories/ by repair.
		const activePath = path.join(memoriesDir(repoKey), `${id}.md`);
		await expect(fs.access(activePath)).rejects.toThrow();
	}, 30_000);
});
