import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import { transcodeCacheToDb } from "../../src/lib/cache-store-sqlite.js";
import { getCacheDbFilePath } from "../../src/lib/cache-store.js";
import { startGraphServer } from "../../src/server/graph-server.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import type { RepoCache } from "../../src/lib/models.js";
import type { RunningServer } from "../../src/server/graph-server.js";

// End-to-end coverage for `cortex graph`: drive the real HTTP server the CLI
// serves, so the viewer shell (the built 3D bundle) and the live retrieval
// endpoints (`/suggest`, `/recall`) cannot break silently.

const WEB_DIR = path.resolve("dist/web/graph");

function cache(repoKey: string): RepoCache {
	return {
		schemaVersion: "3.1",
		repoKey,
		worktreeKey: "wt00000000000000",
		worktreePath: "/wt",
		indexedAt: "t",
		fingerprint: "f",
		packageMeta: { name: "fix", version: "0.0.0", framework: null },
		entryFiles: [],
		files: [{ path: "a.ts", kind: "file" }],
		docs: [],
		imports: [],
		functions: [],
		calls: [],
	};
}

describe("cortex graph e2e: viewer shell", () => {
	let stop: (() => Promise<void>) | null = null;

	// The 3D bundle (app3d.js) is the viewer; without it the page is blank. Build
	// it once if a prior task has not already produced it.
	beforeAll(() => {
		if (!fs.existsSync(path.join(WEB_DIR, "app3d.js"))) {
			execFileSync("node", ["scripts/build-web.mjs"], { stdio: "ignore" });
		}
	}, 60_000);

	afterEach(async () => {
		if (stop) await stop();
		stop = null;
	});

	async function serve(): Promise<RunningServer> {
		const srv = await startGraphServer({
			webDir: WEB_DIR,
			host: "127.0.0.1",
			port: 0,
		});
		stop = srv.stop;
		return srv;
	}

	it("serves index.html that boots the 3D bundle", async () => {
		const srv = await serve();
		const res = await fetch(`${srv.url}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("app3d.js");
		expect(html).toContain("$ cortex graph");
	});

	it("serves the built app3d.js and overlay.css with correct content types", async () => {
		const srv = await serve();
		const js = await fetch(`${srv.url}/app3d.js`);
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toContain("javascript");
		expect((await js.text()).length).toBeGreaterThan(1000);

		const css = await fetch(`${srv.url}/overlay.css`);
		expect(css.status).toBe(200);
		expect(css.headers.get("content-type")).toContain("text/css");
	});

	it("does not serve files outside the web dir", async () => {
		const srv = await serve();
		const res = await fetch(`${srv.url}/..%2f..%2fpackage.json`);
		expect(res.status).not.toBe(200);
	});
});

describe("cortex graph e2e: data + retrieval endpoints", () => {
	const keys: string[] = [];
	let stop: (() => Promise<void>) | null = null;

	afterEach(async () => {
		if (stop) await stop();
		stop = null;
		for (const k of keys.splice(0)) await cleanupRepo(k);
	});

	async function serve(): Promise<RunningServer> {
		const srv = await startGraphServer({
			webDir: WEB_DIR,
			host: "127.0.0.1",
			port: 0,
		});
		stop = srv.stop;
		return srv;
	}

	it("serves a code GraphPayload for a seeded repo", async () => {
		const repoKey = await mkRepoKey("graph-e2e");
		keys.push(repoKey);
		transcodeCacheToDb(
			cache(repoKey),
			getCacheDbFilePath(repoKey, "wt00000000000000"),
		);

		const srv = await serve();
		const res = await fetch(`${srv.url}/graph?mode=code&scope=all&full=1`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.mode).toBe("code");
		expect(Array.isArray(body.nodes)).toBe(true);
		expect(
			body.nodes.some((n: { id: string }) => n.id.includes(repoKey)),
		).toBe(true);
	});

	it("/suggest returns 400 without a usable project and task", async () => {
		const repoKey = await mkRepoKey("graph-e2e-suggest");
		keys.push(repoKey);
		const srv = await serve();

		expect((await fetch(`${srv.url}/suggest`)).status).toBe(400);
		// known project but no task
		expect(
			(await fetch(`${srv.url}/suggest?project=${repoKey}`)).status,
		).toBe(400);
		// task but no resolvable worktree for an unknown project
		expect(
			(await fetch(`${srv.url}/suggest?project=nope&task=index%20files`))
				.status,
		).toBe(400);
	});

	it("/recall returns 400 without a query", async () => {
		const repoKey = await mkRepoKey("graph-e2e-recall-guard");
		keys.push(repoKey);
		const srv = await serve();
		expect((await fetch(`${srv.url}/recall`)).status).toBe(400);
	});

	it("/recall returns a seeded memory as a namespaced graph node", async () => {
		const repoKey = await mkRepoKey("graph-e2e-recall");
		keys.push(repoKey);

		const lc = await openLifecycle(repoKey);
		let memId: string;
		try {
			memId = await createMemory(lc, {
				type: "decision",
				title: "Blast radius uses impact adjacency",
				body: "## Rule\nBlast radius traverses reverse imports and forward contains.\n\n## Why\nIt models what a change affects.\n\n## Alternatives considered\nForward-only traversal.",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const srv = await serve();
		const res = await fetch(
			`${srv.url}/recall?project=${repoKey}&query=${encodeURIComponent(
				"how does blast radius work",
			)}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.results)).toBe(true);
		expect(body.results.length).toBeGreaterThan(0);
		const hit = body.results.find(
			(r: { nodeId: string }) => r.nodeId === `memory:${repoKey}:${memId}`,
		);
		expect(hit).toBeDefined();
		expect(hit.title).toBe("Blast radius uses impact adjacency");
		expect(hit.type).toBe("decision");
	}, 30_000);
});
