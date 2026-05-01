import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
	writeMemoryFile,
	readMemoryFile,
	listMemoryFiles,
	moveToTrash,
	restoreFromTrash,
	purgeMemoryFile,
} from "../../../../src/lib/memory/store.js";
import { memoriesDir, trashDir } from "../../../../src/lib/memory/paths.js";
import type { MemoryRecord } from "../../../../src/lib/memory/types.js";

let originalCacheHome: string | undefined;
let tmp: string;
const repoKey = "testrepo";

beforeEach(async () => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-store-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(() => {
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
});

function rec(id: string, body = "## Body\nx"): MemoryRecord {
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
		body,
	};
}

describe("writeMemoryFile / readMemoryFile", () => {
	it("writes atomically and reads back the same record", async () => {
		const r = rec("mem-2026-04-30-x-aaa111");
		await writeMemoryFile(repoKey, r);
		const back = await readMemoryFile(repoKey, r.frontmatter.id, "memories");
		expect(back).toEqual(r);
	});

	it("uses .tmp + rename (no .tmp file remains after success)", async () => {
		const r = rec("mem-2026-04-30-y-bbb222");
		await writeMemoryFile(repoKey, r);
		const files = await fs.readdir(memoriesDir(repoKey));
		expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});
});

describe("listMemoryFiles", () => {
	it("returns id, location, mtime for every .md under memories/ and trash/", async () => {
		await writeMemoryFile(repoKey, rec("mem-2026-04-30-a-100000"));
		await writeMemoryFile(repoKey, rec("mem-2026-04-30-b-200000"));
		const list = await listMemoryFiles(repoKey);
		expect(list.map((x) => x.id).sort()).toEqual([
			"mem-2026-04-30-a-100000",
			"mem-2026-04-30-b-200000",
		]);
		expect(list.every((x) => x.location === "memories")).toBe(true);
	});
});

describe("moveToTrash / restoreFromTrash / purgeMemoryFile", () => {
	it("moves the file from memories/ to trash/ and back", async () => {
		const r = rec("mem-2026-04-30-c-300000");
		await writeMemoryFile(repoKey, r);
		await moveToTrash(repoKey, r.frontmatter.id);
		expect(
			await fs
				.access(path.join(memoriesDir(repoKey), `${r.frontmatter.id}.md`))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
		expect(
			await fs
				.access(path.join(trashDir(repoKey), `${r.frontmatter.id}.md`))
				.then(() => true)
				.catch(() => false),
		).toBe(true);
		await restoreFromTrash(repoKey, r.frontmatter.id);
		expect(
			await fs
				.access(path.join(memoriesDir(repoKey), `${r.frontmatter.id}.md`))
				.then(() => true)
				.catch(() => false),
		).toBe(true);
	});

	it("hard-deletes when purge is called", async () => {
		const r = rec("mem-2026-04-30-d-400000");
		await writeMemoryFile(repoKey, r);
		await purgeMemoryFile(repoKey, r.frontmatter.id, "memories");
		expect(
			await fs
				.access(path.join(memoriesDir(repoKey), `${r.frontmatter.id}.md`))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});
});
