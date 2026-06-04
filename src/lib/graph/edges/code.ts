// src/lib/graph/edges/code.ts
import { fileId, projectId, symbolId } from "../types.js";
import type { CodeStore, GraphEdge, GraphNode } from "../types.js";

export function projectNode(store: CodeStore, memCount: number): GraphNode {
	return {
		id: projectId(store.repoKey),
		kind: "project",
		label: store.worktreePath.split("/").pop() ?? store.repoKey,
		cluster: store.repoKey,
		meta: { files: store.files.length, memories: memCount },
	};
}

export function fileNodes(store: CodeStore): GraphNode[] {
	return store.files.map((f) => ({
		id: fileId(store.repoKey, f.path),
		kind: "file",
		label: f.path.split("/").pop() ?? f.path,
		cluster: store.repoKey,
		meta: { path: f.path, kind: f.kind },
	}));
}

export function importEdges(store: CodeStore): GraphEdge[] {
	const known = new Set(store.files.map((f) => f.path));
	const out: GraphEdge[] = [];
	for (const i of store.imports) {
		// Only emit edges between files we have nodes for, so the payload is
		// self-consistent (no dangling endpoints).
		if (!known.has(i.from) || !known.has(i.to)) continue;
		out.push({
			source: fileId(store.repoKey, i.from),
			target: fileId(store.repoKey, i.to),
			rel: "imports",
		});
	}
	return out;
}

// A focused file's symbols and the resolved, in-file call edges between them.
export function symbolNodes(store: CodeStore, filePath: string): GraphNode[] {
	return store.functions
		.filter((fn) => fn.file === filePath)
		.map((fn) => ({
			id: symbolId(store.repoKey, filePath, fn.qualifiedName),
			kind: "symbol" as const,
			label: fn.qualifiedName,
			cluster: store.repoKey,
			meta: { file: filePath, line: fn.line, exported: fn.exported },
		}));
}

export function callEdges(store: CodeStore, filePath: string): GraphEdge[] {
	const prefix = `${filePath}::`;
	const inFile = new Set(
		store.functions
			.filter((fn) => fn.file === filePath)
			.map((fn) => `${filePath}::${fn.qualifiedName}`),
	);
	const out: GraphEdge[] = [];
	for (const c of store.calls) {
		if (!c.from.startsWith(prefix)) continue; // caller not in this file
		if (!inFile.has(c.to)) continue; // unresolved or cross-file target
		out.push({
			// c.from / c.to are already "<file>::<qualifiedName>", so prefixing the
			// repoKey yields exactly symbolId(repoKey, file, qn).
			source: `symbol:${store.repoKey}:${c.from}`,
			target: `symbol:${store.repoKey}:${c.to}`,
			rel: "calls",
			meta: { kind: c.kind },
		});
	}
	return out;
}
