// web/graph/app-core.ts
export type GraphMode = "code" | "memory" | "bridge";
export type Node = {
	id: string;
	kind: string;
	label: string;
	cluster: string;
	meta?: Record<string, unknown>;
};
export type Edge = {
	source: string;
	target: string;
	rel: string;
	weight?: number;
};
export type ClusterLabel = { key: string; label: string };
export type Payload = {
	nodes: Node[];
	edges: Edge[];
	mode: string;
	level: string;
	clusters?: ClusterLabel[];
};

export type RNode = {
	id: string;
	label: string; // node title (for hover / detail)
	color: string; // deterministic fallback; the shell may recolor by category
	category: string; // memory type, or code node kind
	size: number;
	alpha: number;
	cluster: string;
};
export type RLink = { source: string; target: string };
export interface Renderer {
	setData(nodes: RNode[], links: RLink[]): void;
}

export type ViewState = {
	mode: GraphMode;
	scope: "all" | { project: string };
	focus?: string;
	semantic?: boolean;
	flat?: boolean;
};

// ANSI-ish phosphor palette; one hue per cluster, amber for global.
const PALETTE = ["#33ff66", "#2ee6e6", "#ff5fcf", "#5f9fff", "#ff7a4d", "#cba6f7"];
export function colorFor(cluster: string): string {
	if (cluster === "global") return "#ffcc33";
	let h = 0;
	for (const c of cluster) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return PALETTE[h % PALETTE.length]!;
}

// Color encodes CATEGORY (position + label already encode project). Sharp
// phosphor/ANSI hues to match the terminal aesthetic: memory by type, code by
// kind. Capture is a muted phosphor and is further dimmed via alpha.
const TYPE_COLORS: Record<string, string> = {
	decision: "#39d0ff", // sharp cyan-blue
	gotcha: "#ff3b5c", // sharp red
	pattern: "#33ff77", // phosphor green
	"how-to": "#ffd11a", // sharp amber
	capture: "#4f7a66", // muted phosphor (background dust)
};
const KIND_COLORS: Record<string, string> = {
	project: "#ffd11a",
	dir: "#2ee6e6",
	file: "#39d0ff",
	symbol: "#c77dff",
};

export function nodeColor(n: Node): string {
	if (n.kind === "memory") {
		const t = (n.meta?.type as string | undefined) ?? "";
		return TYPE_COLORS[t] ?? "#8aa0b6";
	}
	return KIND_COLORS[n.kind] ?? "#8aa0b6";
}

// The category a node is colored by: memory type, or code node kind.
export function nodeCategory(n: Node): string {
	if (n.kind === "memory") {
		return (n.meta?.type as string | undefined) ?? "other";
	}
	return n.kind;
}

// Brightness encodes CONFIDENCE, like a star's magnitude: high-confidence
// memories burn bright; low-confidence and raw captures fade to dim dust.
export function nodeAlpha(n: Node): number {
	if (n.kind !== "memory") return 0.95;
	const type = n.meta?.type as string | undefined;
	if (type === "capture") return 0.16; // raw, unreviewed -> background dust
	const confidence = Math.max(0, Math.min(1, Number(n.meta?.confidence ?? 0.5)));
	return 0.4 + 0.6 * confidence;
}

// Size encodes IMPORTANCE: pinned memories are largest, then frequently used,
// then high-confidence. Captures stay tiny; code nodes size by kind.
export function nodeSize(n: Node): number {
	if (n.kind === "memory") {
		if ((n.meta?.type as string | undefined) === "capture") return 2.5;
		const pinned = n.meta?.pinned ? 1 : 0;
		const getCount = Number(n.meta?.getCount ?? 0);
		const confidence = Number(n.meta?.confidence ?? 0.5);
		const s = 2 + pinned * 7 + Math.log2(getCount + 1) * 2.2 + confidence * 6;
		return Math.min(18, Math.max(2.5, s));
	}
	return n.kind === "project"
		? 12
		: n.kind === "dir"
			? 8
			: n.kind === "file"
				? 5
				: 4;
}

export function toCosmos(p: Payload): { nodes: RNode[]; links: RLink[] } {
	const present = new Set(p.nodes.map((n) => n.id));
	return {
		nodes: p.nodes.map((n) => ({
			id: n.id,
			label: n.label,
			color: nodeColor(n),
			category: nodeCategory(n),
			size: nodeSize(n),
			alpha: nodeAlpha(n),
			cluster: n.cluster,
		})),
		links: p.edges
			.filter((e) => present.has(e.source) && present.has(e.target))
			.map((e) => ({ source: e.source, target: e.target })),
	};
}

export function queryFor(s: ViewState): string {
	const params = new URLSearchParams();
	params.set("mode", s.mode);
	params.set("scope", s.scope === "all" ? "all" : s.scope.project);
	if (s.focus) params.set("focus", s.focus);
	if (s.semantic) params.set("semantic", "1");
	if (s.flat) params.set("flat", "1");
	return `/graph?${params.toString()}`;
}

// Drill-down: clicking (or zooming into) a node yields the deeper view, or null
// for a leaf (memory/symbol) that should show a detail card instead of drilling.
export function nextStateForNode(node: Node, s: ViewState): ViewState | null {
	if (node.kind === "project") {
		return { mode: s.mode, scope: { project: node.cluster }, semantic: s.semantic };
	}
	if (node.kind === "dir" || node.kind === "file") {
		return {
			mode: s.mode,
			scope: s.scope === "all" ? { project: node.cluster } : s.scope,
			focus: node.id,
			semantic: s.semantic,
		};
	}
	return null;
}

// Zoom scale (renderer units) past which a scroll-in descends one level.
export const ZOOM_DRILL_THRESHOLD = 4;

export class GraphController {
	private state: ViewState = { mode: "memory", scope: "all" };
	private stack: ViewState[] = [];
	// The original payload nodes from the last render, in the SAME order handed
	// to the renderer (toCosmos preserves order), so a click/zoom index maps back
	// to its source node. This is what makes drill-down wireable from the shell.
	private lastNodes: Node[] = [];
	private lastClusters: ClusterLabel[] = [];
	constructor(
		private renderer: Renderer,
		private fetchFn: typeof fetch,
		private onLeaf?: (node: Node) => void,
		// Optional shell hook fired after each render with the source nodes (e.g.
		// for labels/breadcrumb); the controller itself owns index->node mapping.
		private onRender?: (nodes: Node[]) => void,
		initial?: ViewState,
	) {
		if (initial) this.state = initial;
	}

	current(): ViewState {
		return this.state;
	}
	canGoBack(): boolean {
		return this.stack.length > 0;
	}

	async render(): Promise<void> {
		const res = await this.fetchFn(queryFor(this.state));
		const payload = (await res.json()) as Payload;
		this.lastNodes = payload.nodes;
		this.lastClusters = payload.clusters ?? [];
		const data = toCosmos(payload);
		this.renderer.setData(data.nodes, data.links);
		this.onRender?.(payload.nodes);
	}

	nodeAt(index: number): Node | undefined {
		return this.lastNodes[index];
	}

	clusters(): ClusterLabel[] {
		return this.lastClusters;
	}

	// Click seam: the shell forwards a rendered node index; we resolve it to its
	// source node and drill in. Tested directly so the wiring is provable.
	async clickIndex(index: number): Promise<void> {
		const node = this.lastNodes[index];
		if (node) await this.drillInto(node);
	}

	// Semantic-zoom seam: when the zoom scale crosses the threshold, descend into
	// the node nearest the viewport center (index supplied by the renderer).
	async zoomDrill(
		centralIndex: number,
		scale: number,
		threshold = ZOOM_DRILL_THRESHOLD,
	): Promise<void> {
		if (scale < threshold) return;
		await this.clickIndex(centralIndex);
	}

	// Mode is a lens switch, switchable at ANY level (spec line 176): it swaps
	// only the mode and preserves the current scope, focus, and breadcrumb so
	// the user stays at their current drill level. Modes that ignore `focus`
	// (memory, bridge) simply do not use it; the leftover is harmless.
	async setMode(mode: GraphMode): Promise<void> {
		this.state = { ...this.state, mode };
		await this.render();
	}

	async drillInto(node: Node): Promise<void> {
		const next = nextStateForNode(node, this.state);
		if (!next) {
			this.onLeaf?.(node);
			return;
		}
		this.stack.push(this.state);
		this.state = next;
		await this.render();
	}

	async back(): Promise<void> {
		const prev = this.stack.pop();
		if (!prev) return;
		this.state = prev;
		await this.render();
	}
}
