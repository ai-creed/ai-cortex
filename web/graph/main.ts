// web/graph/main.ts
//
// Thin, version-sensitive shell adapting the tested, renderer-agnostic
// GraphController (app-core.ts) to the installed @cosmograph/cosmos API.
// Cosmos v2 is a points/links API fed as Float32Arrays. We DISABLE Cosmos'
// own force simulation (it diverges with this graph) and instead drive a
// deterministic, bounded animation ourselves: a slow whole-galaxy rotation
// plus a gentle intra-cluster swirl. Bounded math => it can never fly away.
import { Graph } from "@cosmograph/cosmos";
import {
	GraphController,
	type GraphMode,
	type Node,
	type RLink,
	type RNode,
	type Renderer,
} from "./app-core.js";

const container = document.getElementById("graph") as HTMLDivElement;

const graph = new Graph(container, {
	backgroundColor: "#02060a",
	pointSize: 6,
	linkWidth: 0.4,
	linkColor: "rgba(80,170,110,0.16)",
	renderLinks: true,
	scalePointsOnZoom: true,
	disableSimulation: true,
});

type Layout = {
	n: number;
	positions: Float32Array; // working [x,y,...] buffer, recomputed each frame
	localX: Float32Array; // per-point offset within its cluster
	localY: Float32Array;
	pointCluster: Int32Array; // cluster index per point
	centerX: number[]; // per-cluster base center (on a ring)
	centerY: number[];
	clusterKeys: string[];
};
let layout: Layout | null = null;
let needsFit = false;

// "#rrggbb" => [r, g, b, a] floats in 0..1 for setPointColors.
function hexToRgba(hex: string): [number, number, number, number] {
	const h = hex.replace("#", "");
	return [
		parseInt(h.slice(0, 2), 16) / 255,
		parseInt(h.slice(2, 4), 16) / 255,
		parseInt(h.slice(4, 6), 16) / 255,
		1,
	];
}

// Deterministic per-cluster shapes so no two constellations look alike.
function hash(seed: number): number {
	const x = Math.sin(seed * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}
type ShapeFn = (k: number, count: number) => [number, number];
const SHAPES: ShapeFn[] = [
	// phyllotaxis disk
	(k) => {
		const a = k * 2.399963;
		const r = 6 * Math.sqrt(k + 1);
		return [Math.cos(a) * r, Math.sin(a) * r];
	},
	// two-arm spiral galaxy
	(k, n) => {
		const arm = k % 2;
		const t = (Math.floor(k / 2) + 1) / (n / 2 + 1);
		const a = t * Math.PI * 3 + arm * Math.PI;
		const r = t * 8 * Math.sqrt(n);
		const j = (hash(k) - 0.5) * 7;
		return [Math.cos(a) * r + j, Math.sin(a) * r + j];
	},
	// ring / annulus
	(k, n) => {
		const R = 7 * Math.sqrt(n);
		const a = (k / Math.max(1, n)) * Math.PI * 2;
		const r = R * (0.82 + 0.18 * hash(k));
		return [Math.cos(a) * r, Math.sin(a) * r];
	},
	// square grid
	(k, n) => {
		const cols = Math.ceil(Math.sqrt(n));
		const rows = Math.ceil(n / cols);
		const s = 9;
		return [
			((k % cols) - (cols - 1) / 2) * s,
			(Math.floor(k / cols) - (rows - 1) / 2) * s,
		];
	},
	// horizontal streak (wide and thin)
	(k, n) => {
		const W = 11 * Math.sqrt(n);
		return [(k / Math.max(1, n) - 0.5) * W, (hash(k) - 0.5) * W * 0.22];
	},
	// scatter cloud
	(k, n) => {
		const R = 7 * Math.sqrt(n);
		const a = hash(k) * Math.PI * 2;
		const r = R * Math.sqrt(hash(k + 1000));
		return [Math.cos(a) * r, Math.sin(a) * r];
	},
];

function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = a[i]!;
		a[i] = a[j]!;
		a[j] = tmp;
	}
	return a;
}

// Randomized per page load: a shape order (so clusters don't always get the
// same shape) and a phosphor palette assigned to categories on first sight.
// Reload = a fresh generative galaxy; stable within a session so drilling is
// not chaotic. Capture stays muted regardless so it reads as background dust.
const SHAPE_ORDER = shuffle(SHAPES.map((_, i) => i));
const PHOSPHOR = [
	"#39d0ff",
	"#ff3b5c",
	"#33ff77",
	"#ffd11a",
	"#c77dff",
	"#2ee6e6",
	"#ff7a4d",
	"#5f9fff",
];
const PALETTE = shuffle(PHOSPHOR);
const categoryColor = new Map<string, string>();
let nextColorIdx = 0;
function colorForCategory(category: string): string {
	if (category === "capture") return "#4f7a66";
	let c = categoryColor.get(category);
	if (!c) {
		c = PALETTE[nextColorIdx % PALETTE.length]!;
		nextColorIdx++;
		categoryColor.set(category, c);
	}
	return c;
}

function updateLegend(categories: string[]): void {
	const el = document.getElementById("legend")!;
	const chips = categories
		.map(
			(cat) =>
				`<span class="chip" style="color:${colorForCategory(cat)}">● ${cat}</span>`,
		)
		.join("");
	el.innerHTML =
		chips +
		'<span class="chip dim">· size = importance · brightness = confidence · position = project · click to inspect</span>';
}

const renderer: Renderer = {
	setData(nodes: RNode[], links: RLink[]) {
		const n = nodes.length;
		const index = new Map<string, number>();
		const colors = new Float32Array(n * 4);
		const sizes = new Float32Array(n);
		const localX = new Float32Array(n);
		const localY = new Float32Array(n);
		const pointCluster = new Int32Array(n);

		const groups = new Map<string, number[]>();
		for (let i = 0; i < n; i++) {
			const node = nodes[i]!;
			index.set(node.id, i);
			let g = groups.get(node.cluster);
			if (!g) {
				g = [];
				groups.set(node.cluster, g);
			}
			g.push(i);
			const [r, gr, b] = hexToRgba(colorForCategory(node.category));
			colors[i * 4] = r;
			colors[i * 4 + 1] = gr;
			colors[i * 4 + 2] = b;
			colors[i * 4 + 3] = node.alpha; // brightness = confidence
			sizes[i] = node.size;
		}

		// Clusters spaced on a ring; each point at a phyllotaxis offset within it.
		const clusterKeys = [...groups.keys()];
		const C = clusterKeys.length;
		const ring = 160 + C * 16;
		// Global is the hub at center; every other project surrounds it on a ring.
		const surround = clusterKeys.filter((k) => k !== "global");
		const Cs = surround.length;
		const centerX: number[] = [];
		const centerY: number[] = [];
		clusterKeys.forEach((key, ci) => {
			if (key === "global" || C === 1) {
				centerX[ci] = 0;
				centerY[ci] = 0;
			} else {
				const si = surround.indexOf(key);
				const ca = (si / Math.max(1, Cs)) * Math.PI * 2;
				centerX[ci] = Math.cos(ca) * ring;
				centerY[ci] = Math.sin(ca) * ring;
			}
			// Each cluster gets a distinct shape from the per-load shuffled order.
			const shape = SHAPES[SHAPE_ORDER[ci % SHAPES.length]!]!;
			const members = groups.get(key)!;
			for (let k = 0; k < members.length; k++) {
				const idx = members[k]!;
				const [lx, ly] = shape(k, members.length);
				// Compact clusters a touch so they sit closer without overlapping.
				localX[idx] = lx * 0.7;
				localY[idx] = ly * 0.7;
				pointCluster[idx] = ci;
			}
		});

		const pairs: number[] = [];
		for (const l of links) {
			const s = index.get(l.source);
			const t = index.get(l.target);
			if (s !== undefined && t !== undefined) pairs.push(s, t);
		}
		// Colors/sizes/links are static; positions animate in the frame loop.
		graph.setPointColors(colors);
		graph.setPointSizes(sizes);
		graph.setLinks(Float32Array.from(pairs));
		layout = {
			n,
			positions: new Float32Array(n * 2),
			localX,
			localY,
			pointCluster,
			centerX,
			centerY,
			clusterKeys,
		};
		needsFit = true;
		updateLegend([...new Set(nodes.map((nd) => nd.category))]);
	},
};

function showCard(node: Node): void {
	void fetch(`/node/${encodeURIComponent(node.id)}`).then(async (r) => {
		const card = document.getElementById("card")!;
		card.hidden = false;
		card.textContent = JSON.stringify(await r.json(), null, 2);
	});
}

function renderBreadcrumb(): void {
	const el = document.getElementById("breadcrumb")!;
	el.textContent = controller.canGoBack() ? "< back" : "";
	el.onclick = () => void controller.back();
}

// Start in semantic mode so the default galaxy threads similar memories across
// projects (otherwise links are intra-project only and clusters look isolated).
const controller = new GraphController(
	renderer,
	fetch.bind(window),
	showCard,
	() => renderBreadcrumb(),
	{ mode: "memory", scope: "all", semantic: true },
);

// The node nearest the viewport center, used for semantic-zoom drill-in.
function centralPointIndex(): number | undefined {
	const rect = container.getBoundingClientRect();
	const center = graph.screenToSpacePosition([rect.width / 2, rect.height / 2]);
	let best: number | undefined;
	let bestDist = Infinity;
	for (const [i, [x, y]] of graph.getSampledPointPositionsMap()) {
		const dx = x - center[0];
		const dy = y - center[1];
		const d = dx * dx + dy * dy;
		if (d < bestDist) {
			bestDist = d;
			best = i;
		}
	}
	return best;
}

graph.setConfig({
	onClick: (index?: number) => {
		if (index !== undefined) void controller.clickIndex(index);
	},
	onZoom: (_e: unknown, userDriven?: boolean) => {
		if (!userDriven) return; // ignore programmatic zoom (fitView)
		const idx = centralPointIndex();
		if (idx !== undefined) void controller.zoomDrill(idx, graph.getZoomLevel());
	},
});

const modeSel = document.getElementById("mode") as HTMLSelectElement;
modeSel.addEventListener("change", () => {
	void controller.setMode(modeSel.value as GraphMode);
});

// --- bounded animation + label loop (single rAF) ---
const labelLayer = document.getElementById("labels") as HTMLDivElement;
const labelEls = new Map<string, HTMLDivElement>();
const SPIN = 0.00004; // whole-galaxy rotation (rad/ms); full turn ~2.6 min
const SWIRL = 0.00009; // intra-cluster rotation (rad/ms)

function frame(t: number): void {
	const L = layout;
	if (L) {
		const cos = Math.cos(t * SPIN);
		const sin = Math.sin(t * SPIN);
		const lcos = Math.cos(t * SWIRL);
		const lsin = Math.sin(t * SWIRL);
		const rcx: number[] = [];
		const rcy: number[] = [];
		for (let c = 0; c < L.clusterKeys.length; c++) {
			rcx[c] = L.centerX[c]! * cos - L.centerY[c]! * sin;
			rcy[c] = L.centerX[c]! * sin + L.centerY[c]! * cos;
		}
		for (let i = 0; i < L.n; i++) {
			const c = L.pointCluster[i]!;
			const lx = L.localX[i]!;
			const ly = L.localY[i]!;
			L.positions[i * 2] = rcx[c]! + (lx * lcos - ly * lsin);
			L.positions[i * 2 + 1] = rcy[c]! + (lx * lsin + ly * lcos);
		}
		graph.setPointPositions(L.positions);
		graph.render();
		if (needsFit) {
			graph.fitView(250, 0.05); // tight padding => viewport sits closer
			needsFit = false;
		}
		positionLabels(rcx, rcy, L.clusterKeys);
	}
	requestAnimationFrame(frame);
}

function positionLabels(
	rcx: number[],
	rcy: number[],
	clusterKeys: string[],
): void {
	const labelMap = new Map(controller.clusters().map((c) => [c.key, c.label]));
	const present = new Set<string>();
	for (let c = 0; c < clusterKeys.length; c++) {
		const key = clusterKeys[c]!;
		present.add(key);
		let el = labelEls.get(key);
		if (!el) {
			el = document.createElement("div");
			el.className = "clabel";
			labelLayer.appendChild(el);
			labelEls.set(key, el);
		}
		el.textContent = labelMap.get(key) ?? key.slice(0, 8);
		const screen = graph.spaceToScreenPosition([rcx[c]!, rcy[c]!]);
		el.style.left = `${screen[0]}px`;
		el.style.top = `${screen[1]}px`;
	}
	for (const [key, el] of labelEls) {
		el.style.display = present.has(key) ? "block" : "none";
	}
}

requestAnimationFrame(frame);
void controller.render();
