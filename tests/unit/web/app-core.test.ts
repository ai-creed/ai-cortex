import { describe, it, expect } from "vitest";
import {
	GraphController,
	queryFor,
	nextStateForNode,
	type Node,
	type Renderer,
	type ViewState,
} from "../../../web/graph/app-core.js";

function jsonFetch(payload: unknown, calls?: string[]): typeof fetch {
	return (async (url: string) => {
		calls?.push(String(url));
		return { json: async () => payload } as Response;
	}) as unknown as typeof fetch;
}

const node = (id: string, kind: string, cluster: string): Node => ({
	id,
	kind,
	label: id,
	cluster,
});

describe("app-core controller", () => {
	it("mounts and fetches /graph, feeding mapped data to the renderer", async () => {
		const calls: string[] = [];
		const fetchFn = jsonFetch(
			{
				mode: "memory",
				level: "project",
				nodes: [node("memory:r:m1", "memory", "r")],
				edges: [],
			},
			calls,
		);
		let received: { nodes: { id: string; color: string }[] } | null = null;
		const renderer: Renderer = {
			setData: (nodes) => {
				received = { nodes };
			},
		};
		const c = new GraphController(renderer, fetchFn);
		await c.render();
		expect(calls[0]).toBe("/graph?mode=memory&scope=all");
		expect(received!.nodes[0]!.id).toBe("memory:r:m1");
		expect(typeof received!.nodes[0]!.color).toBe("string");
	});

	it("drills project -> dir -> file and treats memory as a non-drilling leaf", () => {
		const top: ViewState = { mode: "code", scope: "all" };
		const proj = nextStateForNode(node("project:r", "project", "r"), top);
		expect(proj).toEqual({ mode: "code", scope: { project: "r" } });
		expect(queryFor(proj!)).toBe("/graph?mode=code&scope=r");
		const dir = nextStateForNode(node("dir:r:src", "dir", "r"), proj!);
		expect(dir!.focus).toBe("dir:r:src");
		expect(queryFor(dir!)).toBe("/graph?mode=code&scope=r&focus=dir%3Ar%3Asrc");
		const file = nextStateForNode(node("file:r:src/a.ts", "file", "r"), dir!);
		expect(file!.focus).toBe("file:r:src/a.ts");
		expect(nextStateForNode(node("memory:r:m1", "memory", "r"), top)).toBeNull();
	});

	it("drillInto pushes a breadcrumb and back() restores the prior view", async () => {
		const fetchFn = jsonFetch({ mode: "code", level: "project", nodes: [], edges: [] });
		const c = new GraphController({ setData: () => {} }, fetchFn);
		await c.setMode("code");
		await c.drillInto(node("project:r", "project", "r"));
		expect(c.canGoBack()).toBe(true);
		expect(c.current().scope).toEqual({ project: "r" });
		await c.back();
		expect(c.current().scope).toBe("all");
	});

	it("memory leaf invokes onLeaf instead of drilling", async () => {
		const fetchFn = jsonFetch({ mode: "memory", level: "project", nodes: [], edges: [] });
		let leaf: string | null = null;
		const c = new GraphController({ setData: () => {} }, fetchFn, (n) => {
			leaf = n.id;
		});
		await c.render();
		await c.drillInto(node("memory:r:m1", "memory", "r"));
		expect(leaf).toBe("memory:r:m1");
		expect(c.canGoBack()).toBe(false);
	});

	it("switching mode preserves the current level (mode switchable at any level)", async () => {
		const fetchFn = jsonFetch({ mode: "code", level: "project", nodes: [], edges: [] });
		const c = new GraphController({ setData: () => {} }, fetchFn);
		await c.setMode("code");
		await c.drillInto(node("project:r", "project", "r"));
		await c.drillInto(node("dir:r:src", "dir", "r"));
		expect(c.current().scope).toEqual({ project: "r" });
		expect(c.current().focus).toBe("dir:r:src");

		await c.setMode("memory"); // switch lens from a deep view
		expect(c.current().mode).toBe("memory");
		expect(c.current().scope).toEqual({ project: "r" }); // scope preserved
		expect(c.current().focus).toBe("dir:r:src"); // focus preserved
		expect(c.canGoBack()).toBe(true); // breadcrumb preserved
	});

	it("clickIndex maps a rendered index back to its node and drills in", async () => {
		const payload = {
			mode: "code",
			level: "project",
			nodes: [node("project:r", "project", "r")],
			edges: [],
		};
		const c = new GraphController({ setData: () => {} }, jsonFetch(payload));
		await c.render();
		expect(c.nodeAt(0)!.id).toBe("project:r");
		await c.clickIndex(0); // simulate a renderer click on node index 0
		expect(c.current().scope).toEqual({ project: "r" });
	});

	it("zoomDrill descends only once the scale crosses the threshold", async () => {
		const payload = {
			mode: "code",
			level: "project",
			nodes: [node("project:r", "project", "r")],
			edges: [],
		};
		const c = new GraphController({ setData: () => {} }, jsonFetch(payload));
		await c.render();
		await c.zoomDrill(0, 1); // below threshold => no drill
		expect(c.current().scope).toBe("all");
		await c.zoomDrill(0, 10); // above threshold => drill into central node
		expect(c.current().scope).toEqual({ project: "r" });
	});
});
