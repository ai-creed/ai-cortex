// src/lib/graph/builder.ts
import {
	callEdges,
	fileNodes,
	importEdges,
	projectNode,
	symbolNodes,
} from "./edges/code.js";
import { dirRollup, narrowToDir } from "./aggregate.js";
import { linkEdges, memoryNodes, scopeEdges } from "./edges/memory.js";
import { semanticEdges } from "./edges/semantic.js";
import { anchorEdges } from "./edges/bridge.js";
import type {
	BuildOpts,
	GraphLevel,
	GraphPayload,
	MemoryRecord,
	RepoStores,
} from "./types.js";

function isDirFocus(focus: string | undefined, repoKey: string): boolean {
	return typeof focus === "string" && focus.startsWith(`dir:${repoKey}:`);
}

function isFileFocus(focus: string | undefined, repoKey: string): boolean {
	return typeof focus === "string" && focus.startsWith(`file:${repoKey}:`);
}

function memCountByRepo(stores: RepoStores): Map<string, number> {
	const m = new Map<string, number>();
	for (const mem of stores.memories) {
		m.set(mem.repoKey, (m.get(mem.repoKey) ?? 0) + 1);
	}
	return m;
}

export function buildGraph(stores: RepoStores, opts: BuildOpts): GraphPayload {
	const payload = buildGraphInner(stores, opts);
	payload.clusters = clusterLabels(stores);
	return payload;
}

function clusterLabels(stores: RepoStores): { key: string; label: string }[] {
	const labels = new Map<string, string>();
	for (const s of stores.code) {
		const base = s.worktreePath.split("/").filter(Boolean).pop();
		labels.set(s.repoKey, base && base.length > 0 ? base : s.repoKey.slice(0, 8));
	}
	for (const m of stores.memories) {
		if (!labels.has(m.repoKey)) {
			labels.set(
				m.repoKey,
				m.repoKey === "global" ? "global" : m.repoKey.slice(0, 8),
			);
		}
	}
	return [...labels].map(([key, label]) => ({ key, label }));
}

function buildGraphInner(stores: RepoStores, opts: BuildOpts): GraphPayload {
	if (opts.mode === "memory") {
		const scope = opts.scope;
		let mems: MemoryRecord[];
		let level: GraphLevel;
		if (scope === "all") {
			mems = stores.memories;
			level = "project";
		} else {
			const p = scope.project;
			mems = stores.memories.filter((m) => m.repoKey === p);
			level = "file";
		}
		const edges = [...linkEdges(mems), ...scopeEdges(mems)];
		if (opts.semantic) edges.push(...semanticEdges(mems, opts));
		return {
			mode: "memory",
			scope: opts.scope,
			level,
			nodes: memoryNodes(mems),
			edges,
		};
	}

	if (opts.mode === "bridge" && opts.scope !== "all") {
		const bridgeRepo = opts.scope.project;
		const bstore = stores.code.find((s) => s.repoKey === bridgeRepo);
		const bmems = stores.memories.filter((m) => m.repoKey === bridgeRepo);
		if (!bstore) {
			return {
				mode: "bridge",
				scope: opts.scope,
				level: "file",
				nodes: memoryNodes(bmems),
				edges: [],
			};
		}
		const nodes = [...fileNodes(bstore), ...memoryNodes(bmems)];
		const edges = [...importEdges(bstore), ...anchorEdges(bstore, bmems)];
		return { mode: "bridge", scope: opts.scope, level: "file", nodes, edges };
	}

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

	// file focus => descend to that file's symbols and their resolved calls.
	if (isFileFocus(opts.focus, repoKey)) {
		const filePath = opts.focus!.slice(`file:${repoKey}:`.length);
		return {
			mode: opts.mode,
			scope: opts.scope,
			level: "symbol",
			nodes: symbolNodes(store, filePath),
			edges: callEdges(store, filePath),
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
