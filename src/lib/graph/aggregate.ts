// src/lib/graph/aggregate.ts
import { dirId, projectId } from "./types.js";
import type { CodeStore, GraphEdge, GraphNode } from "./types.js";

export function topDir(filePath: string): string {
	const slash = filePath.indexOf("/");
	return slash === -1 ? "." : filePath.slice(0, slash);
}

/** A shallow copy of the store narrowed to files whose top segment is `dir`.
 *  Reused by the builder's dir-focus branch so fileNodes/importEdges (which key
 *  off store.files) naturally restrict to that directory. */
export function narrowToDir(store: CodeStore, dir: string): CodeStore {
	return { ...store, files: store.files.filter((f) => topDir(f.path) === dir) };
}

export function dirRollup(store: CodeStore): {
	nodes: GraphNode[];
	edges: GraphEdge[];
} {
	const fileCount = new Map<string, number>();
	for (const f of store.files) {
		const d = topDir(f.path);
		fileCount.set(d, (fileCount.get(d) ?? 0) + 1);
	}

	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const proj = projectId(store.repoKey);
	nodes.push({
		id: proj,
		kind: "project",
		label: store.worktreePath.split("/").pop() ?? store.repoKey,
		cluster: store.repoKey,
	});
	for (const [dir, count] of fileCount) {
		const id = dirId(store.repoKey, dir);
		nodes.push({
			id,
			kind: "dir",
			label: dir,
			cluster: store.repoKey,
			meta: { files: count },
		});
		edges.push({ source: proj, target: id, rel: "contains" });
	}

	// Aggregate file->file imports into dir->dir edges (dedup, drop self loops).
	const seen = new Set<string>();
	for (const imp of store.imports) {
		const a = topDir(imp.from);
		const b = topDir(imp.to);
		if (a === b) continue;
		const key = `${a} ${b}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({
			source: dirId(store.repoKey, a),
			target: dirId(store.repoKey, b),
			rel: "imports",
		});
	}
	return { nodes, edges };
}
