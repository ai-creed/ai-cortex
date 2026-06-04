// src/lib/graph/load.ts
import fs from "node:fs";
import { getCacheDir } from "../cache-store.js";
import { readFromDb } from "../cache-store-sqlite.js";
import { openRetrieve, listMemories } from "../memory/retrieve.js";
import { openMemoryVectorIndex } from "../memory/embed.js";
import { discoverStoreKeys, discoverDbFiles } from "./discover.js";
import type {
	CodeStore,
	MemoryRecord,
	RepoStores,
	GraphScope,
} from "./types.js";

export type LoadOpts = {
	scope: GraphScope;
	semantic?: boolean;
};

function loadCodeStore(repoKey: string): CodeStore | null {
	const dir = getCacheDir(repoKey);
	const dbFiles = discoverDbFiles(dir);
	if (dbFiles.length === 0) return null;
	// Pick the first valid worktree store; multiple worktrees are rare and the
	// galaxy treats a project as one cluster.
	for (const dbPath of dbFiles) {
		const cache = readFromDb(dbPath);
		if (!cache) continue;
		return {
			repoKey,
			worktreePath: cache.worktreePath,
			files: cache.files.map((f) => ({ path: f.path, kind: f.kind })),
			imports: cache.imports.map((i) => ({ from: i.from, to: i.to })),
			functions: cache.functions.map((fn) => ({
				qualifiedName: fn.qualifiedName,
				file: fn.file,
				exported: fn.exported,
				line: fn.line,
			})),
			calls: cache.calls.map((c) => ({
				from: c.from,
				to: c.to,
				kind: c.kind,
			})),
		};
	}
	return null;
}

async function loadMemories(
	repoKey: string,
	semantic: boolean,
): Promise<MemoryRecord[]> {
	// Memory store may be absent for a freshly indexed repo.
	if (!fs.existsSync(`${getCacheDir(repoKey)}/memory/index.sqlite`)) return [];

	const rh = openRetrieve(repoKey);
	const lookup = semantic ? await openMemoryVectorIndex(repoKey) : null;
	try {
		const items = listMemories(rh, { limit: 100000 });
		return items.map((it) => {
			const scope = rh.index.scopeRows(it.id);
			const vec = lookup ? lookup(it.id) : null;
			const rec: MemoryRecord = {
				repoKey,
				id: it.id,
				type: it.type,
				status: it.status,
				title: it.title,
				scopeFiles: scope.filter((s) => s.kind === "file").map((s) => s.value),
				scopeTags: scope.filter((s) => s.kind === "tag").map((s) => s.value),
				links: rh.index
					.linksFrom(it.id)
					.map((e) => ({ dstId: e.dstId, relType: e.relType })),
			};
			if (vec) rec.vector = vec.vector;
			return rec;
		});
	} finally {
		rh.close();
	}
}

export async function loadRepoStores(opts: LoadOpts): Promise<RepoStores> {
	const keys =
		opts.scope === "all" ? discoverStoreKeys() : [opts.scope.project];

	const code: CodeStore[] = [];
	const memories: MemoryRecord[] = [];
	for (const key of keys) {
		if (key !== "global") {
			const cs = loadCodeStore(key);
			if (cs) code.push(cs);
		}
		const mems = await loadMemories(key, opts.semantic ?? false);
		memories.push(...mems);
	}
	return { code, memories };
}
