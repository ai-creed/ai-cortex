// src/cli/graph.ts
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
	// Resolves when the user ends the session (Ctrl-C); injectable so tests do
	// not block on the real signal wait.
	keepAlive: (srv: RunningServer) => Promise<void>;
};

// Real default: open the URL in the OS browser. Best-effort and detached so the
// CLI does not depend on the child.
function defaultOpenBrowser(url: string): Promise<void> {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// Opening is best-effort; the served URL is already printed to stdout.
	}
	return Promise.resolve();
}

function waitForSigint(srv: RunningServer): Promise<void> {
	return new Promise<void>((resolve) => {
		process.once("SIGINT", () => {
			void srv.stop().then(resolve);
		});
	});
}

const DEFAULT_DEPS: GraphDeps = {
	startServer: startGraphServer,
	openBrowser: defaultOpenBrowser,
	keepAlive: waitForSigint,
};

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

// The web bundle (app3d.js + index.html) is emitted to dist/web/graph by
// scripts/build-web.mjs. Resolve it for both run layouts and pick whichever
// actually contains the built bundle:
//   built: dist/src/cli  -> ../../web/graph       (= dist/web/graph)
//   dev:   src/cli (tsx) -> ../../dist/web/graph
// The source web/graph holds only TS sources (no app3d.js), so running from
// source must reach into dist for the bundle.
export function resolveWebDir(here: string): string {
	const candidates = [
		path.resolve(here, "../../web/graph"),
		path.resolve(here, "../../dist/web/graph"),
	];
	return (
		candidates.find((d) => fs.existsSync(path.join(d, "app3d.js"))) ??
		candidates[0]!
	);
}

function webDir(): string {
	return resolveWebDir(path.dirname(fileURLToPath(import.meta.url)));
}

export async function runGraphCommand(
	args: string[],
	deps: Partial<GraphDeps> = {},
): Promise<number> {
	const { startServer, openBrowser, keepAlive } = { ...DEFAULT_DEPS, ...deps };

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
	const srv: RunningServer = await startServer({
		webDir: webDir(),
		host: "127.0.0.1",
		port: portStr ? Number(portStr) : 0,
	});
	process.stdout.write(`cortex graph serving at ${srv.url}\n`);
	// Default behavior opens the browser; --no-open suppresses it.
	if (!hasFlag(args, "--no-open")) await openBrowser(srv.url);
	// Keep the process alive until Ctrl-C; shut the server down cleanly.
	await keepAlive(srv);
	return 0;
}
