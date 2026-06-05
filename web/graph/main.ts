// web/graph/main.ts
//
// Thin, version-sensitive shell adapting the tested, renderer-agnostic
// GraphController (app-core.ts) to the installed @cosmograph/cosmos API.
// Cosmos v2 is a points/links API: data is fed as Float32Arrays
// (positions, RGBA colors, link index-pairs) and events are config callbacks.
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
	pointSize: 4,
	linkWidth: 0.5,
	renderLinks: true,
	fitViewOnInit: true,
});

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

const renderer: Renderer = {
	setData(nodes: RNode[], links: RLink[]) {
		const n = nodes.length;
		const index = new Map<string, number>();
		const positions = new Float32Array(n * 2);
		const colors = new Float32Array(n * 4);
		for (let i = 0; i < n; i++) {
			const node = nodes[i]!;
			index.set(node.id, i);
			// Seed positions on a phyllotaxis spiral so the force simulation starts
			// from a spread layout rather than a single point.
			const angle = i * 2.399963;
			const radius = 8 * Math.sqrt(i + 1);
			positions[i * 2] = Math.cos(angle) * radius;
			positions[i * 2 + 1] = Math.sin(angle) * radius;
			const [r, g, b, a] = hexToRgba(node.color);
			colors[i * 4] = r;
			colors[i * 4 + 1] = g;
			colors[i * 4 + 2] = b;
			colors[i * 4 + 3] = a;
		}
		const pairs: number[] = [];
		for (const l of links) {
			const s = index.get(l.source);
			const t = index.get(l.target);
			if (s !== undefined && t !== undefined) pairs.push(s, t);
		}
		graph.setPointPositions(positions);
		graph.setPointColors(colors);
		graph.setLinks(Float32Array.from(pairs));
		graph.render();
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

// The controller owns index->node mapping (it keeps the last payload's nodes in
// render order), so the shell only forwards raw renderer event indices.
const controller = new GraphController(
	renderer,
	fetch.bind(window),
	showCard,
	() => renderBreadcrumb(),
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

// Click + zoom both drill in via the tested controller seams.
graph.setConfig({
	onClick: (index?: number) => {
		if (index !== undefined) void controller.clickIndex(index);
	},
	onZoom: () => {
		const idx = centralPointIndex();
		if (idx !== undefined) void controller.zoomDrill(idx, graph.getZoomLevel());
	},
});

const modeSel = document.getElementById("mode") as HTMLSelectElement;
modeSel.addEventListener("change", () => {
	void controller.setMode(modeSel.value as GraphMode);
});

void controller.render();
