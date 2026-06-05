// web/graph/main3d.ts
//
// 3D shell: same renderer-agnostic GraphController (app-core.ts), rendered with
// 3d-force-graph (Three.js). Positions are deterministic (cluster spheres on a
// fibonacci sphere around the global hub) and fixed, so nothing drifts; the
// galaxy feels alive via slow camera auto-rotation + user orbit/zoom.
import ForceGraph3D, { type NodeObject } from "3d-force-graph";
import SpriteText from "three-spritetext";
import { Vector2 } from "three";
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
	val: number;
	label: string;
	x: number;
	y: number;
	z: number;
	fx: number;
	fy: number;
	fz: number;
};
const asN = (o: NodeObject): N3 => o as unknown as N3;

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

const Graph = new ForceGraph3D(container, { controlType: "orbit" })
	.backgroundColor("#02060a")
	.nodeRelSize(0.5)
	.nodeColor((o: NodeObject) => asN(o).color)
	.nodeVal((o: NodeObject) => asN(o).val)
	.nodeLabel((o: NodeObject) => asN(o).label)
	.nodeOpacity(0.95)
	.linkColor(() => "rgba(80,170,110,0.18)")
	.linkWidth(0.3)
	.linkOpacity(0.22)
	.cooldownTicks(0)
	.warmupTicks(0)
	// Positions are fixed, so dragging is pointless — and its DragControls
	// conflicts with OrbitControls on pointer-up (throws on click). Disable it.
	.enableNodeDrag(false)
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

const renderer: Renderer = {
	setData(nodes: RNode[], links: RLink[]) {
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
					// 3d-force-graph sizes spheres by cbrt(val); cube so radius is
					// linear in our size score and differences actually show.
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
		}, 60);
	},
};

function updateLegend(catColor: Map<string, string>): void {
	const el = document.getElementById("legend")!;
	const chips = [...catColor]
		.map(
			([cat, color]) =>
				`<span class="chip" style="color:${color}">● ${cat}</span>`,
		)
		.join("");
	el.innerHTML =
		chips +
		'<span class="chip dim">· size = importance · brightness = confidence · drag to orbit · scroll to zoom · click to inspect</span>';
}

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

const controller = new GraphController(
	renderer,
	fetch.bind(window),
	showCard,
	() => renderBreadcrumb(),
	{ mode: "memory", scope: "all", semantic: true },
);

Graph.onNodeClick((o: NodeObject) => {
	const idx = asN(o).idx;
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

void controller.render();
