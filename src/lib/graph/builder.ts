// src/lib/graph/builder.ts
import { fileNodes, importEdges, projectNode } from "./edges/code.js";
import { dirRollup, narrowToDir } from "./aggregate.js";
import type { BuildOpts, GraphPayload, RepoStores } from "./types.js";

function isDirFocus(focus: string | undefined, repoKey: string): boolean {
	return typeof focus === "string" && focus.startsWith(`dir:${repoKey}:`);
}

function memCountByRepo(stores: RepoStores): Map<string, number> {
	const m = new Map<string, number>();
	for (const mem of stores.memories) {
		m.set(mem.repoKey, (m.get(mem.repoKey) ?? 0) + 1);
	}
	return m;
}

export function buildGraph(stores: RepoStores, opts: BuildOpts): GraphPayload {
	if (opts.scope === "all") {
		const counts = memCountByRepo(stores);
		const nodes = stores.code.map((s) =>
			projectNode(s, counts.get(s.repoKey) ?? 0),
		);
		return {
			mode: opts.mode,
			scope: opts.scope,
			level: "project",
			nodes,
			edges: [],
		};
	}

	const repoKey = opts.scope.project;
	const store = stores.code.find((s) => s.repoKey === repoKey);
	if (!store) {
		return {
			mode: opts.mode,
			scope: opts.scope,
			level: "file",
			nodes: [],
			edges: [],
		};
	}

	// flat => the whole project at file level (the spectacle).
	if (opts.flat === true) {
		return {
			mode: opts.mode,
			scope: opts.scope,
			level: "file",
			nodes: fileNodes(store),
			edges: importEdges(store),
		};
	}
	// dir focus => expand ONLY that directory's files and intra-dir imports.
	if (isDirFocus(opts.focus, repoKey)) {
		const dir = opts.focus!.slice(`dir:${repoKey}:`.length);
		const narrowed = narrowToDir(store, dir);
		return {
			mode: opts.mode,
			scope: opts.scope,
			level: "file",
			nodes: fileNodes(narrowed),
			edges: importEdges(narrowed),
		};
	}
	// default => dir rollup (bounded).
	const { nodes, edges } = dirRollup(store);
	return { mode: opts.mode, scope: opts.scope, level: "dir", nodes, edges };
}
