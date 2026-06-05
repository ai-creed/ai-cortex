// src/server/graph-server.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadRepoStores } from "../lib/graph/load.js";
import { buildGraph } from "../lib/graph/builder.js";
import { loadNodeDetail } from "../lib/graph/detail.js";
import { fileId } from "../lib/graph/types.js";
import { discoverStoreKeys, discoverDbFiles } from "../lib/graph/discover.js";
import { getCacheDir } from "../lib/cache-store.js";
import { readFromDb } from "../lib/cache-store-sqlite.js";
import { suggestRepo } from "../lib/suggest.js";
import { openRetrieve, recallMemory } from "../lib/memory/retrieve.js";
import type { BuildOpts, GraphScope } from "../lib/graph/types.js";

// Resolve a project's on-disk worktree path (needed by suggest_files).
function worktreePathFor(repoKey: string): string | null {
	for (const dbPath of discoverDbFiles(getCacheDir(repoKey))) {
		const cache = readFromDb(dbPath);
		if (cache) return cache.worktreePath;
	}
	return null;
}

// recall_memory across stores; node ids are namespaced to match the graph.
async function recallAcross(
	query: string,
	project: string | null,
): Promise<{ nodeId: string; title: string; type: string; score: number }[]> {
	const keys =
		!project || project === "all" ? discoverStoreKeys() : [project];
	const out: { nodeId: string; title: string; type: string; score: number }[] =
		[];
	for (const key of keys) {
		if (!fs.existsSync(`${getCacheDir(key)}/memory/index.sqlite`)) continue;
		const rh = openRetrieve(key);
		try {
			const results = await recallMemory(rh, query, { limit: 8 });
			for (const r of results) {
				out.push({
					nodeId: `memory:${key}:${r.id}`,
					title: r.title,
					type: r.type,
					score: r.score,
				});
			}
		} finally {
			rh.close();
		}
	}
	out.sort((a, b) => b.score - a.score);
	return out.slice(0, 30);
}

export type GraphServerOpts = {
	webDir: string;
	host?: string;
	port?: number;
	// Injectable for tests; defaults to spawning $EDITOR (no-op if unset).
	openFile?: (filePath: string, line?: number) => boolean;
};

export type RunningServer = {
	url: string;
	port: number;
	stop: () => Promise<void>;
};

function defaultOpenFile(filePath: string, line?: number): boolean {
	const editor = process.env.EDITOR;
	if (!editor) return false;
	const target = line ? `${filePath}:${line}` : filePath;
	spawn(editor, [target], { detached: true, stdio: "ignore" }).unref();
	return true;
}

const CONTENT_TYPE: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

function parseBuildOpts(url: URL): BuildOpts {
	const project = url.searchParams.get("scope");
	const scope: GraphScope = !project || project === "all" ? "all" : { project };
	const mode = (url.searchParams.get("mode") ?? "memory") as BuildOpts["mode"];
	const opts: BuildOpts = { mode, scope };
	const focus = url.searchParams.get("focus");
	if (focus) opts.focus = focus;
	if (url.searchParams.get("flat") === "1") opts.flat = true;
	if (url.searchParams.get("semantic") === "1") opts.semantic = true;
	if (url.searchParams.get("full") === "1") opts.full = true;
	return opts;
}

function serveStatic(
	webDir: string,
	urlPath: string,
	res: http.ServerResponse,
): void {
	const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
	const filePath = path.join(webDir, rel);
	// Prevent path traversal outside webDir.
	if (!filePath.startsWith(path.resolve(webDir))) {
		res.writeHead(403).end();
		return;
	}
	fs.readFile(filePath, (err, buf) => {
		if (err) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type":
				CONTENT_TYPE[path.extname(filePath)] ?? "application/octet-stream",
		});
		res.end(buf);
	});
}

export async function startGraphServer(
	opts: GraphServerOpts,
): Promise<RunningServer> {
	const host = opts.host ?? "127.0.0.1";
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${host}`);
		if (url.pathname === "/graph") {
			const build = parseBuildOpts(url);
			loadRepoStores({ scope: build.scope, semantic: build.semantic })
				.then((stores) => {
					const payload = buildGraph(stores, build);
					res.writeHead(200, { "content-type": CONTENT_TYPE[".json"]! });
					res.end(JSON.stringify(payload));
				})
				.catch((err: unknown) => {
					res.writeHead(500, { "content-type": CONTENT_TYPE[".json"]! });
					res.end(JSON.stringify({ error: String(err) }));
				});
			return;
		}
		if (url.pathname.startsWith("/node/")) {
			const id = decodeURIComponent(url.pathname.slice("/node/".length));
			const detail = loadNodeDetail(id);
			if (!detail) {
				res.writeHead(404, { "content-type": CONTENT_TYPE[".json"]! });
				res.end(JSON.stringify({ error: "not found" }));
				return;
			}
			res.writeHead(200, { "content-type": CONTENT_TYPE[".json"]! });
			res.end(JSON.stringify(detail));
			return;
		}
		if (url.pathname === "/open") {
			const p = url.searchParams.get("path");
			const lineStr = url.searchParams.get("line");
			const open = opts.openFile ?? defaultOpenFile;
			const opened = p
				? open(p, lineStr ? Number(lineStr) : undefined)
				: false;
			res.writeHead(200, { "content-type": CONTENT_TYPE[".json"]! });
			res.end(JSON.stringify({ opened }));
			return;
		}
		if (url.pathname === "/suggest") {
			const project = url.searchParams.get("project");
			const task = url.searchParams.get("task");
			const wt = project ? worktreePathFor(project) : null;
			if (!project || !task || !wt) {
				res.writeHead(400, { "content-type": CONTENT_TYPE[".json"]! });
				res.end(JSON.stringify({ error: "project (with worktree) + task required" }));
				return;
			}
			suggestRepo(wt, task, { mode: "deep", limit: 20, stale: true })
				.then((r) => {
					const results = r.results.map((it) => ({
						id: fileId(project, it.path),
						path: it.path,
						score: it.score,
						reason: it.reason,
					}));
					res.writeHead(200, { "content-type": CONTENT_TYPE[".json"]! });
					res.end(JSON.stringify({ task, results }));
				})
				.catch((err: unknown) => {
					res.writeHead(500, { "content-type": CONTENT_TYPE[".json"]! });
					res.end(JSON.stringify({ error: String(err) }));
				});
			return;
		}
		if (url.pathname === "/recall") {
			const query = url.searchParams.get("query");
			if (!query) {
				res.writeHead(400, { "content-type": CONTENT_TYPE[".json"]! });
				res.end(JSON.stringify({ error: "query required" }));
				return;
			}
			recallAcross(query, url.searchParams.get("project"))
				.then((results) => {
					res.writeHead(200, { "content-type": CONTENT_TYPE[".json"]! });
					res.end(JSON.stringify({ query, results }));
				})
				.catch((err: unknown) => {
					res.writeHead(500, { "content-type": CONTENT_TYPE[".json"]! });
					res.end(JSON.stringify({ error: String(err) }));
				});
			return;
		}
		serveStatic(opts.webDir, url.pathname, res);
	});

	await new Promise<void>((resolve) =>
		server.listen(opts.port ?? 0, host, resolve),
	);
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
		port,
		stop: () =>
			new Promise<void>((resolve, reject) =>
				server.close((e) => (e ? reject(e) : resolve())),
			),
	};
}
