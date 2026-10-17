import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { transcodeCacheToDb } from "../../../../src/lib/cache-store-sqlite.js";
import { getCacheDbFilePath } from "../../../../src/lib/cache-store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import type { RepoCache } from "../../../../src/lib/models.js";
import type { MemoryFrontmatter } from "../../../../src/lib/memory/types.js";
import {
	discoverDbFiles,
	discoverStoreKeys,
} from "../../../../src/lib/graph/discover.js";
import { loadRepoStores } from "../../../../src/lib/graph/load.js";

function minimalCache(repoKey: string): RepoCache {
	return {
		schemaVersion: "3.2",
		indexSeq: 0,
		contentFingerprint: "",
		symbols: [],
		refs: [],
		reexports: [],
		repoKey,
		worktreeKey: "wt00000000000000",
		worktreePath: "/tmp/wt",
		indexedAt: "2026-06-04T00:00:00.000Z",
		fingerprint: "fp",
		packageMeta: { name: "fix", version: "0.0.0", framework: null },
		entryFiles: [],
		files: [
			{ path: "src/a.ts", kind: "file" },
			{ path: "src/b.ts", kind: "file" },
		],
		docs: [],
		imports: [{ from: "src/a.ts", to: "src/b.ts" }],
		functions: [],
		calls: [],
	};
}

function fm(id: string, files: string[], tags: string[]): MemoryFrontmatter {
	return {
		id,
		type: "decision",
		status: "active",
		title: "use sqlite",
		version: 1,
		createdAt: "2026-06-04T00:00:00.000Z",
		updatedAt: "2026-06-04T00:00:00.000Z",
		source: "explicit",
		confidence: 0.9,
		pinned: false,
		scope: { files, tags },
		provenance: [],
		supersedes: [],
		mergedInto: null,
		deprecationReason: null,
		promotedFrom: [],
		rewrittenAt: null,
	};
}

describe("discover + load", () => {
	const keys: string[] = [];
	afterEach(async () => {
		for (const k of keys.splice(0)) await cleanupRepo(k);
	});

	it("loads a project's code store and memories into RepoStores", async () => {
		const repoKey = await mkRepoKey("graph-load");
		keys.push(repoKey);

		transcodeCacheToDb(
			minimalCache(repoKey),
			getCacheDbFilePath(repoKey, "wt00000000000000"),
		);

		const idx = openMemoryIndex(repoKey);
		idx.upsertMemory(fm("mem-1", ["src/a.ts"], ["storage"]), {
			bodyHash: "h",
			bodyExcerpt: "body",
			body: "the memory body",
		});
		idx.close();

		const found = discoverStoreKeys();
		expect(found).toContain(repoKey);

		const stores = await loadRepoStores({ scope: { project: repoKey } });
		expect(stores.code).toHaveLength(1);
		expect(stores.code[0]!.files).toHaveLength(2);
		expect(stores.code[0]!.imports).toHaveLength(1);
		expect(stores.memories).toHaveLength(1);
		expect(stores.memories[0]!.id).toBe("mem-1");
		expect(stores.memories[0]!.repoKey).toBe(repoKey);
		expect(stores.memories[0]!.scopeFiles).toEqual(["src/a.ts"]);
		expect(stores.memories[0]!.scopeTags).toEqual(["storage"]);
	});
});

describe("discoverDbFiles", () => {
	it("lists worktree stores and skips the .seq.db sequence sidecar", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-discover-"));
		try {
			for (const f of ["wt00000000000000.db", "wt00000000000000.seq.db", "wt00000000000000.meta.json"]) {
				fs.writeFileSync(path.join(dir, f), "");
			}
			expect(discoverDbFiles(dir)).toEqual([path.join(dir, "wt00000000000000.db")]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
