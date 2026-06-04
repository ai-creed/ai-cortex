// src/cli/graph.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoStores } from "../lib/graph/load.js";
import { buildGraph } from "../lib/graph/builder.js";
import { startGraphServer } from "../server/graph-server.js";
import { resolveRepoIdentity } from "../lib/repo-identity.js";
import type { BuildOpts, GraphScope } from "../lib/graph/types.js";
import type { RunningServer } from "../server/graph-server.js";

export type GraphDeps = {
	startServer: typeof startGraphServer;
	openBrowser: (url: string) => Promise<void>;
};

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

function webDir(): string {
	// Built bundle ships under dist/web/graph (see scripts/build-web.mjs).
	const here = path.dirname(fileURLToPath(import.meta.url)); // dist/src/cli
	return path.resolve(here, "../../web/graph");
}

export async function runGraphCommand(
	args: string[],
	deps: GraphDeps = {
		startServer: startGraphServer,
		openBrowser: async () => {},
	},
): Promise<number> {
	const project = flagValue(args, "--project");
	const scope: GraphScope = project
		? { project: resolveRepoIdentity(project).repoKey }
		: "all";
	const mode = (flagValue(args, "--mode") ?? "memory") as BuildOpts["mode"];
	const opts: BuildOpts = { mode, scope };
	if (hasFlag(args, "--flat")) opts.flat = true;
	if (hasFlag(args, "--semantic")) opts.semantic = true;

	const exportPath = flagValue(args, "--export");
	if (exportPath) {
		const stores = await loadRepoStores({ scope, semantic: opts.semantic });
		const payload = buildGraph(stores, opts);
		fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2));
		process.stdout.write(`Wrote graph to ${exportPath}\n`);
		return 0;
	}

	const portStr = flagValue(args, "--port");
	const srv: RunningServer = await deps.startServer({
		webDir: webDir(),
		host: "127.0.0.1",
		port: portStr ? Number(portStr) : 0,
	});
	process.stdout.write(`cortex graph serving at ${srv.url}\n`);
	if (!hasFlag(args, "--no-open")) await deps.openBrowser(srv.url);
	// Keep the process alive until Ctrl-C; shut the server down cleanly.
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => {
			void srv.stop().then(resolve);
		});
	});
	return 0;
}
