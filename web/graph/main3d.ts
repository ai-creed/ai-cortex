// web/graph/main3d.ts
//
// 3D shell: same renderer-agnostic GraphController (app-core.ts), rendered with
// 3d-force-graph (Three.js). Positions are deterministic (cluster spheres on a
// fibonacci sphere around the global hub) and fixed, so nothing drifts; the
// galaxy feels alive via slow camera auto-rotation + user orbit/zoom.
import ForceGraph3D, { type NodeObject } from "3d-force-graph";
import SpriteText from "three-spritetext";
import {
	Vector2,
	Mesh,
	MeshBasicMaterial,
	SphereGeometry,
	OctahedronGeometry,
	CylinderGeometry,
	BufferGeometry,
	BufferAttribute,
	Points,
	PointsMaterial,
	Color,
	AdditiveBlending,
} from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
	GraphController,
	type GraphMode,
	type Node,
	type RLink,
	type RNode,
	type Renderer,
} from "./app-core.js";

type N3 = {
	id: string;
	idx: number;
	color: string;
	category: string;
	size: number;
	val: number;
	label: string;
	// Fixed for the memory galaxy; omitted for the code brain (physics places it).
	x?: number;
	y?: number;
	z?: number;
	fx?: number;
	fy?: number;
	fz?: number;
};
const asN = (o: NodeObject): N3 => o as unknown as N3;

// Shape encodes CATEGORY (alongside color), restricted to three clean forms:
// sphere, hexagonal prism, octahedron.
function geometryFor(category: string, r: number): BufferGeometry {
	switch (category) {
		case "gotcha":
		case "symbol":
			return new OctahedronGeometry(r);
		case "pattern":
		case "dir":
			return new CylinderGeometry(r, r, r * 1.2, 6); // hexagonal prism
		default: // decision, how-to, capture, file, project, other
			return new SphereGeometry(r, 14, 14);
	}
}
function nodeMesh(n: N3): Mesh {
	const r = Math.max(1, n.size * 0.5);
	// transparent from creation so runtime opacity changes (blast dimming) take
	// effect without a shader recompile.
	return new Mesh(
		geometryFor(n.category, r),
		new MeshBasicMaterial({ color: n.color, transparent: true }),
	);
}

// Legend glyph per category, matching the 3D geometry.
const CAT_GLYPH: Record<string, string> = {
	decision: "●",
	gotcha: "◆",
	pattern: "⬡",
	"how-to": "●",
	capture: "●",
	file: "●",
	dir: "⬡",
	symbol: "◆",
	project: "●",
};

const container = document.getElementById("graph") as HTMLElement;

// Brightness = confidence: bake alpha into RGB darkness (on black, darker reads
// as dimmer), so captures fade to near-black dust without per-node materials.
function dimColor(hex: string, alpha: number): string {
	const h = hex.replace("#", "");
	const r = Math.round(parseInt(h.slice(0, 2), 16) * alpha);
	const g = Math.round(parseInt(h.slice(2, 4), 16) * alpha);
	const b = Math.round(parseInt(h.slice(4, 6), 16) * alpha);
	return `rgb(${r},${g},${b})`;
}

// Even distribution of n points on a sphere of given radius (used for the
// arrangement of cluster CENTERS around the global hub).
function fib(i: number, n: number, radius: number): [number, number, number] {
	const phi = Math.acos(1 - (2 * (i + 0.5)) / Math.max(1, n));
	const theta = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
	return [
		radius * Math.sin(phi) * Math.cos(theta),
		radius * Math.sin(phi) * Math.sin(theta),
		radius * Math.cos(phi),
	];
}

function hash(seed: number): number {
	const x = Math.sin(seed * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}
function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const t = a[i]!;
		a[i] = a[j]!;
		a[j] = t;
	}
	return a;
}

// Distinct WITHIN-cluster 3D forms (s = cluster scale), shuffled per page load.
type Shape3 = (k: number, n: number, s: number) => [number, number, number];
const SHAPES3: Shape3[] = [
	// hollow sphere
	(k, n, s) => fib(k, n, s),
	// flat disk spiral (galaxy disk), thin in z
	(k, n, s) => {
		const a = k * 2.399963;
		const r = s * Math.sqrt((k + 0.5) / n);
		return [Math.cos(a) * r, Math.sin(a) * r, (hash(k) - 0.5) * s * 0.12];
	},
	// ring / torus
	(k, n, s) => {
		const a = (k / Math.max(1, n)) * Math.PI * 2;
		const R = s * 0.9;
		const tube = s * 0.2;
		const ta = hash(k) * Math.PI * 2;
		return [
			(R + tube * Math.cos(ta)) * Math.cos(a),
			(R + tube * Math.cos(ta)) * Math.sin(a),
			tube * Math.sin(ta),
		];
	},
	// two-arm spiral (flat)
	(k, n, s) => {
		const arm = k % 2;
		const t = (Math.floor(k / 2) + 1) / (n / 2 + 1);
		const a = t * Math.PI * 3 + arm * Math.PI;
		const r = t * s;
		return [Math.cos(a) * r, Math.sin(a) * r, (hash(k) - 0.5) * s * 0.1];
	},
	// 3D lattice cube
	(k, n, s) => {
		const side = Math.ceil(Math.cbrt(n));
		const sp = (2 * s) / Math.max(1, side);
		const x = k % side;
		const y = Math.floor(k / side) % side;
		const z = Math.floor(k / (side * side));
		return [
			(x - (side - 1) / 2) * sp,
			(y - (side - 1) / 2) * sp,
			(z - (side - 1) / 2) * sp,
		];
	},
	// solid cloud (filled sphere)
	(k, n, s) => {
		const r = s * Math.cbrt(hash(k));
		const th = hash(k + 1000) * Math.PI * 2;
		const ph = Math.acos(2 * hash(k + 2000) - 1);
		return [
			r * Math.sin(ph) * Math.cos(th),
			r * Math.sin(ph) * Math.sin(th),
			r * Math.cos(ph),
		];
	},
];
const SHAPE_ORDER3 = shuffle(SHAPES3.map((_, i) => i));

const sprites: SpriteText[] = [];
let firstRender = true;

// Per-dot micro-motion: each mesh oscillates around its fixed base position.
type Anim = {
	o: Mesh;
	bx: number;
	by: number;
	bz: number;
	a: number; // amplitude
	fx: number;
	fy: number;
	fz: number; // per-axis frequency
	px: number;
	py: number;
	pz: number; // per-axis phase
};
let animated: Anim[] = [];

const Graph = new ForceGraph3D(container, { controlType: "orbit" })
	.showNavInfo(false) // hide the lib's built-in "Left-click: rotate…" overlay
	.backgroundColor("#02060a")
	.nodeRelSize(0.5)
	.nodeColor((o: NodeObject) => asN(o).color)
	.nodeVal((o: NodeObject) => asN(o).val)
	.nodeLabel((o: NodeObject) => asN(o).label)
	.nodeThreeObject((o: NodeObject) => {
		const n = asN(o);
		const mesh = nodeMesh(n);
		(n as unknown as { __mesh?: Mesh }).__mesh = mesh;
		return mesh;
	})
	.nodeOpacity(0.95)
	.linkColor(() => "rgba(80,170,110,0.18)")
	.linkWidth(0.3)
	.linkOpacity(0.22)
	.cooldownTicks(0) // overridden per render (0 = galaxy, >0 = code force layout)
	.warmupTicks(0)
	// DragControls conflicts with OrbitControls on pointer-up (throws on click).
	.enableNodeDrag(false)
	// After the code brain's force layout settles, frame it.
	.onEngineStop(() => {
		if (controller.current().mode === "code") Graph.zoomToFit(600, 50);
	})
	.width(window.innerWidth)
	.height(window.innerHeight);

// Bloom: bright (high-confidence / important) nodes glow like stars; dim
// capture dust stays below the threshold.
const bloom = new UnrealBloomPass(
	new Vector2(window.innerWidth, window.innerHeight),
	0.8, // strength (dialed back so dots glow without blooming out)
	0.45, // radius (tighter halo so the glow sits closer to the clickable mesh)
	0.12, // threshold (only the genuinely bright stars bloom)
);
Graph.postProcessingComposer().addPass(bloom);

window.addEventListener("resize", () => {
	Graph.width(window.innerWidth).height(window.innerHeight);
	bloom.setSize(window.innerWidth, window.innerHeight);
});

// Group coloring for the code brain (project or module): distinct hues via the
// golden angle so even many modules stay distinguishable.
const groupIdx = new Map<string, number>();
let nextGroupIdx = 0;
function groupColor(key: string): string {
	let i = groupIdx.get(key);
	if (i === undefined) {
		i = nextGroupIdx++;
		groupIdx.set(key, i);
	}
	return `hsl(${(i * 137.5) % 360}, 75%, 62%)`;
}

// "file:<repoKey>:<path>" -> top-level directory (module) of the file.
function moduleOf(id: string): string {
	const a = id.indexOf(":");
	const b = id.indexOf(":", a + 1);
	const p = b >= 0 ? id.slice(b + 1) : id;
	const s = p.indexOf("/");
	return s === -1 ? "." : p.slice(0, s);
}

// Stored after each brain render so labels can be placed once the force layout
// settles (we need the final node positions to compute group centroids).
let brainLabel: { n3: N3[]; group: string[]; label: Map<string, string> } | null =
	null;
// Blast-radius: impact adjacency (what's affected if a node changes) + the
// currently highlighted set.
let brainImpact = new Map<string, string[]>();
let blastActive: Set<string> | null = null;
// Group show/hide: which groups are hidden, and node-id -> group lookup.
const hiddenGroups = new Set<string>();
let groupOf = new Map<string, string>();
// Nodes of the current render (memory or code) + the base link color, used by
// the highlight overlay (blast / suggest_files / recall_memory).
let currentN3: N3[] = [];
let baseLinkColor = "#9fc4e6";

// Code "brain graph": one force-directed network of all files + imports, laid
// out by physics (no fixed positions). Static, no auto-rotate or per-dot
// motion; structure emerges from the topology. Color = project, size = how
// many files import it (hubs stand out).
function renderBrain(nodes: RNode[], links: RLink[]): void {
	const allProjects = controller.current().scope === "all";
	const indeg = new Map<string, number>();
	for (const l of links) indeg.set(l.target, (indeg.get(l.target) ?? 0) + 1);
	const projLabel = new Map(controller.clusters().map((c) => [c.key, c.label]));

	const group: string[] = [];
	const label = new Map<string, string>();
	const n3: N3[] = nodes.map((node, i) => {
		// All projects -> group by project; single project -> group by module.
		const g = allProjects ? node.cluster : moduleOf(node.id);
		group[i] = g;
		if (!label.has(g)) {
			label.set(g, allProjects ? (projLabel.get(g) ?? g.slice(0, 8)) : g);
		}
		const deg = indeg.get(node.id) ?? 0;
		const size = 3 + Math.sqrt(deg) * 2.4;
		return {
			id: node.id,
			idx: i,
			color: groupColor(g),
			category: node.category,
			size,
			val: size * size * size,
			label: node.label,
		};
	});
	const idset = new Set(n3.map((n) => n.id));
	const filtered = links.filter(
		(l) => idset.has(l.source) && idset.has(l.target),
	);
	const linkObjs = filtered.map((l) => ({ source: l.source, target: l.target }));
	// Impact adjacency for blast-radius: changing X affects its importers/callers
	// (reverse imports/calls) and its own functions (forward contains).
	brainImpact = new Map<string, string[]>();
	for (const l of filtered) {
		const a = l.rel === "contains" ? l.source : l.target;
		const b = l.rel === "contains" ? l.target : l.source;
		const arr = brainImpact.get(a);
		if (arr) arr.push(b);
		else brainImpact.set(a, [b]);
	}
	blastActive = null;

	for (const s of sprites) Graph.scene().remove(s);
	sprites.length = 0;
	animated = [];
	controls.autoRotate = false;
	setBgVisible(false); // starfield/nebula off for the code brain
	bloom.strength = 0.25; // calm the glow; the brain is a map, not a starscape
	// Make the dependency lines clearly visible.
	Graph.linkColor(() => "#9fc4e6")
		.linkWidth(0.7)
		.linkOpacity(0.55);
	brainLabel = { n3, group, label };
	currentN3 = n3;
	baseLinkColor = "#9fc4e6";
	groupOf = new Map();
	for (let i = 0; i < n3.length; i++) groupOf.set(n3[i]!.id, group[i]!);
	hiddenGroups.clear();

	// Tighten the force layout so the brain reads densely (default repulsion
	// spreads ~1600 nodes too far to take in at once).
	const charge = Graph.d3Force("charge") as
		| { strength(v: number): unknown; distanceMax(v: number): unknown }
		| undefined;
	if (charge) {
		charge.strength(-7);
		charge.distanceMax(70);
	}
	const linkF = Graph.d3Force("link") as
		| { distance(v: number): unknown }
		| undefined;
	linkF?.distance(9);

	Graph.cooldownTicks(220); // run the force layout, then settle
	Graph.graphData({ nodes: n3, links: linkObjs });

	const chips = [...label]
		.map(
			([k, l]) =>
				`<span class="chip clickable" data-group="${k}" style="color:${groupColor(k)}">● ${l}</span>`,
		)
		.join("");
	const grouping = allProjects ? "project" : "module";
	document.getElementById("legend")!.innerHTML = chips;
	document.getElementById("hint")!.textContent =
		`color = ${grouping} · click a chip to show/hide · click a file for blast radius · Esc to reset`;
}

// --- group show/hide (clickable legend) ---
function applyGroupVisibility(): void {
	if (!brainLabel) return;
	for (let i = 0; i < brainLabel.n3.length; i++) {
		const mesh = (brainLabel.n3[i] as unknown as { __mesh?: Mesh }).__mesh;
		if (mesh) mesh.visible = !hiddenGroups.has(brainLabel.group[i]!);
	}
	Graph.linkVisibility(linkVisibleForGroups);
}
function linkVisibleForGroups(l: unknown): boolean {
	if (hiddenGroups.size === 0) return true;
	const link = l as {
		source: string | { id: string };
		target: string | { id: string };
	};
	const s = typeof link.source === "object" ? link.source.id : link.source;
	const t = typeof link.target === "object" ? link.target.id : link.target;
	return (
		!hiddenGroups.has(groupOf.get(s) ?? "") &&
		!hiddenGroups.has(groupOf.get(t) ?? "")
	);
}

// --- blast-radius highlight ---
function blastSet(start: string): Set<string> {
	const seen = new Set<string>([start]);
	const q = [start];
	while (q.length) {
		const x = q.shift()!;
		for (const y of brainImpact.get(x) ?? []) {
			if (!seen.has(y)) {
				seen.add(y);
				q.push(y);
			}
		}
	}
	return seen;
}
function matOf(nn: N3): MeshBasicMaterial | undefined {
	const m = (nn as unknown as { __mesh?: Mesh }).__mesh;
	return m ? (m.material as MeshBasicMaterial) : undefined;
}
function linkColorForBlast(l: unknown): string {
	const link = l as {
		source: string | { id: string };
		target: string | { id: string };
	};
	const s = typeof link.source === "object" ? link.source.id : link.source;
	const t = typeof link.target === "object" ? link.target.id : link.target;
	return blastActive && blastActive.has(s) && blastActive.has(t)
		? "#bfe3ff"
		: "rgba(90,110,130,0.03)";
}
// "file:<repo>:<path>" -> "path"; "symbol:<repo>:<file>::<qn>" -> "qn  ·  file".
function displayName(id: string): string {
	const k = id.indexOf(":");
	const kind = id.slice(0, k);
	const rest = id.slice(id.indexOf(":", k + 1) + 1);
	if (kind === "symbol") {
		const i = rest.indexOf("::");
		return i >= 0 ? `${rest.slice(i + 2)}  ·  ${rest.slice(0, i)}` : rest;
	}
	return rest;
}
function applyHighlight(ids: Set<string>): void {
	blastActive = ids;
	for (const nn of currentN3) {
		const mat = matOf(nn);
		if (mat) mat.opacity = ids.has(nn.id) ? 1 : 0.05;
	}
	Graph.linkColor(linkColorForBlast);
}
function clearHighlight(): void {
	blastActive = null;
	for (const nn of currentN3) {
		const mat = matOf(nn);
		if (mat) mat.opacity = 1;
	}
	Graph.linkColor(() => baseLinkColor);
	const panel = document.getElementById("panel");
	if (panel) panel.hidden = true;
}
function esc(s: string): string {
	return s.replace(
		/[&<>"]/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
	);
}
function panelLoading(title: string): void {
	const panel = document.getElementById("panel")!;
	panel.hidden = false;
	panel.innerHTML = `<div class="panel-h">${esc(title)}<span class="panel-x">esc</span></div><div class="panel-meta">…</div>`;
}
function showPanel(
	title: string,
	rows: { id: string; primary: string; secondary?: string }[],
	ids: Set<string>,
): void {
	applyHighlight(ids);
	const panel = document.getElementById("panel")!;
	panel.hidden = false;
	const list = rows
		.slice(0, 600)
		.map(
			(r) =>
				`<li data-id="${esc(r.id)}"><span class="p1">${esc(r.primary)}</span>${
					r.secondary ? `<span class="p2">${esc(r.secondary)}</span>` : ""
				}</li>`,
		)
		.join("");
	panel.innerHTML =
		`<div class="panel-h">${esc(title)}<span class="panel-x">esc</span></div>` +
		`<div class="panel-meta">${rows.length} results</div>` +
		`<ul class="panel-list">${list}</ul>`;
}
function showBlast(selectedId: string): void {
	if (!brainLabel) return;
	const si = document.getElementById("search") as HTMLInputElement | null;
	if (si) si.value = ""; // selecting a node supersedes a search
	const set = blastSet(selectedId);
	const rows = [...set]
		.sort(
			(a, b) =>
				(a.startsWith("file:") ? 0 : 1) - (b.startsWith("file:") ? 0 : 1) ||
				displayName(a).localeCompare(displayName(b)),
		)
		.map((id) => ({ id, primary: displayName(id) }));
	showPanel(`blast radius · ${displayName(selectedId)}`, rows, set);
}
// suggest_files: a real ai-cortex call — given a task, the files an agent opens.
async function runSuggest(task: string): Promise<void> {
	const scope = controller.current().scope;
	if (scope === "all") {
		panelLoading("suggest_files — pick a project first");
		return;
	}
	panelLoading(`suggest_files · "${task}"`);
	const res = await fetch(
		`/suggest?project=${scope.project}&task=${encodeURIComponent(task)}`,
	);
	const data = (await res.json()) as {
		error?: string;
		results?: { id: string; path: string; score: number; reason: string }[];
	};
	if (data.error || !data.results) {
		panelLoading(`suggest_files: ${data.error ?? "no results"}`);
		return;
	}
	const rows = data.results.map((r) => ({
		id: r.id,
		primary: r.path,
		secondary: `${Math.round(r.score)} · ${r.reason}`,
	}));
	showPanel(`suggest_files · "${task}"`, rows, new Set(rows.map((r) => r.id)));
}
// recall_memory: a real ai-cortex call — given a query, the memories an agent recalls.
async function runRecall(query: string): Promise<void> {
	const scope = controller.current().scope;
	const proj = scope === "all" ? "all" : scope.project;
	panelLoading(`recall_memory · "${query}"`);
	const res = await fetch(
		`/recall?query=${encodeURIComponent(query)}&project=${proj}`,
	);
	const data = (await res.json()) as {
		error?: string;
		results?: { nodeId: string; title: string; type: string; score: number }[];
	};
	if (data.error || !data.results) {
		panelLoading(`recall_memory: ${data.error ?? "no results"}`);
		return;
	}
	const rows = data.results.map((r) => ({
		id: r.nodeId,
		primary: r.title,
		secondary: `${r.type} · ${r.score.toFixed(2)}`,
	}));
	showPanel(`recall_memory · "${query}"`, rows, new Set(rows.map((r) => r.id)));
}
function currentSearchMode(): "find" | "suggest" {
	const el = document.getElementById("searchmode") as HTMLSelectElement | null;
	return el?.value === "suggest" ? "suggest" : "find";
}
// The full path (or file::symbol) portion of a node id, after the store prefix.
function pathOf(id: string): string {
	const k = id.indexOf(":");
	return id.slice(id.indexOf(":", k + 1) + 1);
}
// find: name + full-path search over the current code nodes -> highlight + list;
// click a result for its blast radius.
function runFind(query: string): void {
	const q = query.toLowerCase();
	const set = new Set<string>();
	const rows: { id: string; primary: string; secondary?: string }[] = [];
	for (const nn of currentN3) {
		const p = pathOf(nn.id);
		const hay = `${p}\n${displayName(nn.id)}`.toLowerCase();
		if (hay.includes(q)) {
			set.add(nn.id);
			rows.push({ id: nn.id, primary: displayName(nn.id), secondary: p });
		}
	}
	rows.sort((a, b) => a.primary.localeCompare(b.primary));
	showPanel(`find "${query}"`, rows, set);
}

const renderer: Renderer = {
	setData(nodes: RNode[], links: RLink[]) {
		if (controller.current().mode === "code") {
			renderBrain(nodes, links);
			return;
		}
		// --- memory galaxy: deterministic layout, no physics, auto-rotate on ---
		Graph.cooldownTicks(0);
		controls.autoRotate = true;
		setBgVisible(true);
		bloom.strength = 0.8; // full glow for the memory galaxy stars
		// Faint threads for the galaxy (semantic links should stay subtle).
		Graph.linkColor(() => "rgba(80,170,110,0.18)")
			.linkWidth(0.3)
			.linkOpacity(0.22);
		// Group by cluster, build a category->color map for the legend.
		const groups = new Map<string, number[]>();
		const catColor = new Map<string, string>();
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			let g = groups.get(node.cluster);
			if (!g) {
				g = [];
				groups.set(node.cluster, g);
			}
			g.push(i);
			if (!catColor.has(node.category)) catColor.set(node.category, node.color);
		}

		// Global hub at center; the rest of the projects on a fibonacci sphere.
		const clusterKeys = [...groups.keys()];
		const surround = clusterKeys.filter((k) => k !== "global");
		const R = 200 + surround.length * 14;
		const centers = new Map<string, [number, number, number]>();
		clusterKeys.forEach((key) => {
			if (key === "global") {
				centers.set(key, [0, 0, 0]);
			} else {
				centers.set(key, fib(surround.indexOf(key), surround.length, R));
			}
		});

		const n3: N3[] = [];
		[...groups.entries()].forEach(([key, members], ci) => {
			const [cx, cy, cz] = centers.get(key)!;
			const scale = 5 * Math.sqrt(members.length) + 6;
			const shape = SHAPES3[SHAPE_ORDER3[ci % SHAPES3.length]!]!;
			members.forEach((idx, k) => {
				const node = nodes[idx]!;
				const [px, py, pz] = shape(k, members.length, scale);
				const x = cx + px;
				const y = cy + py;
				const z = cz + pz;
				n3.push({
					id: node.id,
					idx,
					color: dimColor(node.color, node.alpha),
					category: node.category,
					size: node.size,
					// kept for fallback; nodeThreeObject controls actual geometry.
					val: node.size * node.size * node.size,
					label: node.label,
					x,
					y,
					z,
					fx: x,
					fy: y,
					fz: z,
				});
			});
		});

		const idset = new Set(n3.map((n) => n.id));
		const linkObjs = links
			.filter((l) => idset.has(l.source) && idset.has(l.target))
			.map((l) => ({ source: l.source, target: l.target }));

		Graph.graphData({ nodes: n3, links: linkObjs });
		currentN3 = n3;
		baseLinkColor = "rgba(80,170,110,0.18)";

		// Cluster labels as camera-facing sprites at each cluster center.
		for (const s of sprites) Graph.scene().remove(s);
		sprites.length = 0;
		const labelMap = new Map(controller.clusters().map((c) => [c.key, c.label]));
		for (const [key, c] of centers) {
			const s = new SpriteText(labelMap.get(key) ?? key.slice(0, 8));
			s.color = "#cdd6f4";
			s.textHeight = 7;
			(
				s as unknown as { position: { set(x: number, y: number, z: number): void } }
			).position.set(c[0], c[1] - 4, c[2]);
			Graph.scene().add(s);
			sprites.push(s);
		}

		updateLegend(catColor);
		setTimeout(() => {
			Graph.zoomToFit(700, 40);
			// First render: after the fit settles, pull the camera in a bit so the
			// galaxy opens up closer rather than fully zoomed out.
			if (firstRender) {
				firstRender = false;
				setTimeout(() => {
					const cp = Graph.cameraPosition();
					Graph.cameraPosition(
						{ x: cp.x * 0.7, y: cp.y * 0.7, z: cp.z * 0.7 },
						{ x: 0, y: 0, z: 0 },
						700,
					);
				}, 760);
			}
			// Capture each node's mesh + base position for per-dot motion.
			animated = [];
			for (const nn of n3) {
				const mesh = (nn as unknown as { __mesh?: Mesh }).__mesh;
				if (!mesh) continue;
				const s = nn.idx;
				animated.push({
					o: mesh,
					bx: nn.x ?? 0,
					by: nn.y ?? 0,
					bz: nn.z ?? 0,
					a: 1.5 + hash(s) * 2.5,
					fx: 0.0008 + hash(s + 1) * 0.0009,
					fy: 0.0008 + hash(s + 2) * 0.0009,
					fz: 0.0008 + hash(s + 3) * 0.0009,
					px: hash(s + 4) * 6.283,
					py: hash(s + 5) * 6.283,
					pz: hash(s + 6) * 6.283,
				});
			}
		}, 60);
	},
};

function updateLegend(catColor: Map<string, string>): void {
	const el = document.getElementById("legend")!;
	const chips = [...catColor]
		.map(
			([cat, color]) =>
				`<span class="chip" style="color:${color}">${CAT_GLYPH[cat] ?? "●"} ${cat}</span>`,
		)
		.join("");
	el.innerHTML = chips;
	document.getElementById("hint")!.textContent =
		"color = type · shape = family · size = importance · brightness = confidence · drag to orbit · scroll to zoom · click to inspect";
}

function showCardById(id: string): void {
	void fetch(`/node/${encodeURIComponent(id)}`).then(async (r) => {
		const card = document.getElementById("card")!;
		card.hidden = false;
		card.textContent = JSON.stringify(await r.json(), null, 2);
	});
}
function showCard(node: Node): void {
	showCardById(node.id);
}
// Click a recall_memory result -> select that memory: isolate it in the galaxy
// (dim the rest) and show its detail card. No camera move; zooming in adds nothing.
function selectMemory(id: string): void {
	applyHighlight(new Set([id]));
	showCardById(id);
}

function renderBreadcrumb(): void {
	const el = document.getElementById("breadcrumb")!;
	el.textContent = controller.canGoBack() ? "< back" : "";
	el.onclick = () => void controller.back();
}

const controller = new GraphController(
	renderer,
	fetch.bind(window),
	showCard,
	() => {
		renderBreadcrumb();
		populateProjects();
		syncControls();
	},
	// Code is the default view: a codebase always exists, while memories
	// accumulate over time (an empty galaxy is a poor first impression).
	{ mode: "code", scope: "all", semantic: true, full: true },
);

// Search demonstrates a real ai-cortex call: suggest_files in code, recall_memory
// in the galaxy. Placeholder reflects the mode.
function syncControls(): void {
	const code = controller.current().mode === "code";
	const sm = document.getElementById("searchmode") as HTMLElement | null;
	if (sm) sm.style.display = code ? "" : "none";
	const search = document.getElementById("search") as HTMLInputElement | null;
	if (search) {
		search.placeholder = !code
			? "query → recall_memory (Enter)"
			: currentSearchMode() === "suggest"
				? "task → suggest_files (Enter)"
				: "file / function name";
	}
}

Graph.onNodeClick((o: NodeObject) => {
	const idx = asN(o).idx;
	if (controller.current().mode === "code") {
		// brain graph: highlight the blast radius + inspect; don't drill.
		showBlast(asN(o).id);
		const node = controller.nodeAt(idx);
		if (node) showCard(node);
		return;
	}
	// Defer so the pointer event fully resolves before graphData is replaced
	// (avoids an OrbitControls pointer-up race on re-render).
	setTimeout(() => void controller.clickIndex(idx), 0);
});

// Slow auto-rotation for an alive, space-like feel (user can still orbit/zoom).
const controls = Graph.controls() as {
	autoRotate?: boolean;
	autoRotateSpeed?: number;
	enableDamping?: boolean;
};
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;
controls.enableDamping = true;

const modeSel = document.getElementById("mode") as HTMLSelectElement;
modeSel.addEventListener("change", () => {
	void controller.setMode(modeSel.value as GraphMode);
});

// Esc clears the highlight (blast/search), the search box, and the card.
window.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	clearHighlight();
	const si = document.getElementById("search") as HTMLInputElement | null;
	if (si) si.value = "";
	const card = document.getElementById("card");
	if (card) card.hidden = true;
});

// File search (code brain): highlight + list matching nodes.
const searchInput = document.getElementById("search") as HTMLInputElement | null;
// Live "find" filtering as you type (code + find mode).
searchInput?.addEventListener("input", () => {
	if (controller.current().mode !== "code" || currentSearchMode() !== "find") {
		return;
	}
	const v = searchInput.value.trim();
	if (!v) clearHighlight();
	else runFind(v);
});
// Enter runs the heavier retrieval: suggest_files (code) or recall_memory (memory).
searchInput?.addEventListener("keydown", (e) => {
	if (e.key !== "Enter") return;
	const v = searchInput.value.trim();
	if (!v) {
		clearHighlight();
		return;
	}
	if (controller.current().mode === "memory") void runRecall(v);
	else if (currentSearchMode() === "suggest") void runSuggest(v);
	else runFind(v);
});
// Switching code search mode (find / suggest_files) resets the box + highlight.
const searchModeSel = document.getElementById(
	"searchmode",
) as HTMLSelectElement | null;
searchModeSel?.addEventListener("change", () => {
	if (searchInput) searchInput.value = "";
	clearHighlight();
	syncControls();
});

// Click a side-panel item: code -> blast radius; memory -> select that memory.
document.getElementById("panel")!.addEventListener("click", (e) => {
	const li = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
	if (!li) return;
	const id = li.getAttribute("data-id")!;
	if (controller.current().mode === "code") showBlast(id);
	else selectMemory(id);
});

// Click a legend chip to show/hide that group's nodes (code brain).
document.getElementById("legend")!.addEventListener("click", (e) => {
	const el = (e.target as HTMLElement).closest("[data-group]") as
		| HTMLElement
		| null;
	if (!el) return;
	const g = el.getAttribute("data-group")!;
	if (hiddenGroups.has(g)) {
		hiddenGroups.delete(g);
		el.classList.remove("off");
	} else {
		hiddenGroups.add(g);
		el.classList.add("off");
	}
	applyGroupVisibility();
});

// Project picker: populated once from the first payload's clusters.
let projectsPopulated = false;
function populateProjects(): void {
	if (projectsPopulated) return;
	const clusters = controller.clusters();
	if (clusters.length === 0) return;
	projectsPopulated = true;
	const sel = document.getElementById("project") as HTMLSelectElement;
	for (const c of clusters) {
		if (c.key === "global") continue; // global has no code
		const opt = document.createElement("option");
		opt.value = c.key;
		opt.textContent = c.label;
		sel.appendChild(opt);
	}
}
const projSel = document.getElementById("project") as HTMLSelectElement;
projSel.addEventListener("change", () => {
	const v = projSel.value;
	void controller.setScope(v === "all" ? "all" : { project: v });
});

// Background ambiance (memory galaxy only; hidden for the code brain so it does
// not pollute the dependency read).
const bgObjects: { visible: boolean }[] = [];
function setBgVisible(v: boolean): void {
	for (const o of bgObjects) o.visible = v;
}
function addBackground(): void {
	const scene = Graph.scene();

	const N = 900;
	const pos = new Float32Array(N * 3);
	const col = new Float32Array(N * 3);
	const tints = [
		new Color(0x9fb4ff),
		new Color(0x7fe0d0),
		new Color(0xcaa6ff),
		new Color(0xc7d2e8),
	];
	for (let i = 0; i < N; i++) {
		const th = hash(i * 3.1) * Math.PI * 2;
		const ph = Math.acos(2 * hash(i * 3.1 + 1) - 1);
		const rr = 1300 + hash(i * 3.1 + 2) * 1700;
		pos[i * 3] = rr * Math.sin(ph) * Math.cos(th);
		pos[i * 3 + 1] = rr * Math.sin(ph) * Math.sin(th);
		pos[i * 3 + 2] = rr * Math.cos(ph);
		const c = tints[Math.floor(hash(i * 5 + 9) * tints.length)]!;
		const b = 0.2 + hash(i * 7 + 3) * 0.55;
		col[i * 3] = c.r * b;
		col[i * 3 + 1] = c.g * b;
		col[i * 3 + 2] = c.b * b;
	}
	const geo = new BufferGeometry();
	geo.setAttribute("position", new BufferAttribute(pos, 3));
	geo.setAttribute("color", new BufferAttribute(col, 3));
	const stars = new Points(
		geo,
		new PointsMaterial({
			size: 2.4,
			sizeAttenuation: true,
			vertexColors: true,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		}),
	);
	scene.add(stars);
	bgObjects.push(stars);

	const nebula: { c: number; r: number; p: [number, number, number] }[] = [
		{ c: 0x123a4a, r: 520, p: [600, 200, -400] },
		{ c: 0x2a1840, r: 460, p: [-520, -300, 320] },
		{ c: 0x103a2a, r: 480, p: [120, 520, 480] },
	];
	for (const nb of nebula) {
		const m = new Mesh(
			new SphereGeometry(nb.r, 24, 24),
			new MeshBasicMaterial({
				color: nb.c,
				transparent: true,
				opacity: 0.05,
				blending: AdditiveBlending,
				depthWrite: false,
			}),
		);
		m.position.set(nb.p[0], nb.p[1], nb.p[2]);
		scene.add(m);
		bgObjects.push(m);
	}
}
addBackground();

// Each dot gently oscillates around its base so clusters feel alive. Bounded
// by amplitude, so nothing can drift away.
function animate(t: number): void {
	for (const m of animated) {
		m.o.position.set(
			m.bx + m.a * Math.sin(t * m.fx + m.px),
			m.by + m.a * Math.sin(t * m.fy + m.py),
			m.bz + m.a * Math.sin(t * m.fz + m.pz),
		);
	}
	requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

void controller.render();
