// web/graph/main.ts
import { Graph } from "@cosmograph/cosmos";
import {
	GraphController,
	type GraphMode,
	type Node,
	type Renderer,
} from "./app-core.js";

const canvas = document.getElementById("graph") as HTMLCanvasElement;
const graph = new Graph(canvas, {
	backgroundColor: "#02060a",
	nodeSize: 4,
	linkWidth: 0.5,
});

const renderer: Renderer = {
	setData(nodes, links) {
		graph.setData(nodes, links);
	},
};

function showCard(node: Node): void {
	void fetch(`/node/${encodeURIComponent(node.id)}`).then(async (r) => {
		const card = document.getElementById("card")!;
		card.hidden = false;
		card.textContent = JSON.stringify(await r.json(), null, 2);
	});
}

// The controller owns index->node mapping (it keeps the last payload's nodes),
// so the shell only forwards raw renderer events. Memory/symbol leaves route to
// showCard; everything else drills in. renderBreadcrumb runs after each nav.
const controller = new GraphController(
	renderer,
	fetch.bind(window),
	showCard,
	() => renderBreadcrumb(),
);

function renderBreadcrumb(): void {
	const el = document.getElementById("breadcrumb")!;
	el.textContent = controller.canGoBack() ? "< back" : "";
	el.onclick = () => void controller.back();
}

const modeSel = document.getElementById("mode") as HTMLSelectElement;
modeSel.addEventListener("change", () => {
	void controller.setMode(modeSel.value as GraphMode);
});

// Click + zoom both drill in via the tested controller seams. The exact event
// API depends on the installed @cosmograph/cosmos version: forward the clicked
// node index to controller.clickIndex, and on zoom read the current scale plus
// the node nearest the viewport center and forward both to controller.zoomDrill.
// If a given version cannot supply a central index, zoom is simply a no-op.
const g = graph as unknown as {
	setConfig?: (c: unknown) => void;
	getZoomLevel?: () => number;
	getCentralNodeIndex?: () => number | undefined;
};
g.setConfig?.({
	onClick: (index?: number) => {
		if (index !== undefined) void controller.clickIndex(index);
	},
	onZoom: () => {
		const scale = g.getZoomLevel?.() ?? 1;
		const centralIndex = g.getCentralNodeIndex?.();
		if (centralIndex !== undefined) void controller.zoomDrill(centralIndex, scale);
	},
});

void controller.render();
