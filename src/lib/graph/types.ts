// src/lib/graph/types.ts

export type NodeKind = "project" | "dir" | "file" | "symbol" | "memory";

export type GraphNode = {
	id: string;
	kind: NodeKind;
	label: string;
	cluster: string; // origin store key (repoKey or "global"); drives color
	meta?: Record<string, unknown>;
};

export type EdgeRel =
	| "imports"
	| "calls"
	| "contains"
	| "link"
	| "scope"
	| "semantic"
	| "anchor";

export type GraphEdge = {
	source: string;
	target: string;
	rel: EdgeRel;
	weight?: number;
	meta?: Record<string, unknown>;
};

export type GraphMode = "code" | "memory" | "bridge";
export type GraphScope = "all" | { project: string };
export type GraphLevel = "project" | "dir" | "file" | "symbol";

export type ClusterLabel = { key: string; label: string };

export type GraphPayload = {
	mode: GraphMode;
	scope: GraphScope;
	level: GraphLevel;
	nodes: GraphNode[];
	edges: GraphEdge[];
	// repoKey -> human label (project basename / "global"); drives cluster labels.
	clusters?: ClusterLabel[];
};

export type BuildOpts = {
	mode: GraphMode;
	scope: GraphScope;
	focus?: string;
	flat?: boolean;
	semantic?: boolean;
	semanticTopK?: number;
	semanticThreshold?: number;
	// code mode: return the whole connected file+import graph at once (the
	// "brain graph"), instead of the drill-down levels.
	full?: boolean;
};

// Pure inputs to the builder; produced by load.ts, never read from disk here.

export type CodeFile = { path: string; kind: string };
export type CodeImport = { from: string; to: string };
export type CodeFunction = {
	qualifiedName: string;
	file: string;
	exported: boolean;
	line: number;
};
export type CodeCall = { from: string; to: string; kind: string };

export type CodeStore = {
	repoKey: string;
	worktreePath: string;
	files: CodeFile[];
	imports: CodeImport[];
	functions: CodeFunction[];
	calls: CodeCall[];
};

export type MemoryRecord = {
	repoKey: string; // origin store key, or "global"
	id: string;
	type: string;
	status: string;
	title: string;
	scopeFiles: string[];
	scopeTags: string[];
	links: { dstId: string; relType: string }[];
	vector?: Float32Array; // present only when semantic edges are requested
	confidence?: number; // 0..1
	getCount?: number; // how often get_memory has been called on it
	pinned?: number; // 0 | 1
};

export type RepoStores = {
	code: CodeStore[];
	memories: MemoryRecord[];
};

// --- store-namespaced id helpers (see spec: Node ID Namespacing) ---

export function projectId(repoKey: string): string {
	return `project:${repoKey}`;
}
export function dirId(repoKey: string, dir: string): string {
	return `dir:${repoKey}:${dir}`;
}
export function fileId(repoKey: string, filePath: string): string {
	return `file:${repoKey}:${filePath}`;
}
export function symbolId(
	repoKey: string,
	file: string,
	qualifiedName: string,
): string {
	return `symbol:${repoKey}:${file}::${qualifiedName}`;
}
export function memoryNodeId(repoKey: string, id: string): string {
	return `memory:${repoKey}:${id}`;
}
