// src/lib/graph/builder.ts
import { fileNodes, importEdges, projectNode } from "./edges/code.js";
import type {
	BuildOpts,
	GraphLevel,
	GraphPayload,
	RepoStores,
} from "./types.js";

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
	// Code mode, single project. Dir rollup arrives in a later task; emit files.
	const level: GraphLevel = "file";
	if (!store) {
		return { mode: opts.mode, scope: opts.scope, level, nodes: [], edges: [] };
	}
	return {
		mode: opts.mode,
		scope: opts.scope,
		level,
		nodes: fileNodes(store),
		edges: importEdges(store),
	};
}
