// src/mcp/server.ts
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
} from "../lib/index.js";
import type { DeepSuggestResult } from "../lib/suggest.js";
import { DeepSuggestResultSchema } from "../lib/suggest.js";

// Keep in sync with package.json "version".
const SERVER_VERSION = "0.0.0-phase0";

function logCall(
	tool: string,
	meta: Record<string, unknown>,
	durMs: number,
	status: "ok" | "error",
	err?: unknown,
): void {
	const parts = [`[ai-cortex] tool=${tool}`];
	for (const [k, v] of Object.entries(meta)) {
		if (v === undefined) continue;
		const s = String(v);
		parts.push(`${k}=${s.length > 80 ? s.slice(0, 77) + "..." : s}`);
	}
	parts.push(`dur=${durMs}ms`);
	parts.push(`status=${status}`);
	if (status === "error" && err instanceof Error) {
		parts.push(`err="${err.message}"`);
	}
	process.stderr.write(parts.join(" ") + "\n");
}

function logged<P, R>(
	tool: string,
	extractMeta: (params: P) => Record<string, unknown>,
	handler: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
	return async (params: P) => {
		const t0 = performance.now();
		try {
			const result = await handler(params);
			logCall(tool, extractMeta(params), Math.round(performance.now() - t0), "ok");
			return result;
		} catch (err) {
			logCall(tool, extractMeta(params), Math.round(performance.now() - t0), "error", err);
			throw err;
		}
	};
}

export function createServer(): McpServer {
	const server = new McpServer({ name: "ai-cortex", version: SERVER_VERSION });

	server.tool(
		"rehydrate_project",
		"Load project context for the current session. Call this once at the start of any session when working in a git repository. Returns a markdown briefing covering project structure, key files, entry points, and recent changes.",
		{ path: z.string().optional() },
		logged("rehydrate_project", (p) => ({ path: p.path }), async ({ path }) => {
			const repoPath = path ?? process.cwd();
			const result = await rehydrateRepo(repoPath);
			const briefing = fs.readFileSync(result.briefingPath, "utf8");
			return {
				content: [
					{
						type: "text" as const,
						text: `<!-- cache: ${result.cacheStatus} -->\n${briefing}`,
					},
				],
			};
		}),
	);

	server.registerTool(
		"suggest_files",
		{
			description:
				"Get a ranked list of files relevant to a task. Uses deep ranking by " +
				"default: path tokens, function names, import/call graph, trigram fuzzy " +
				"match, and content scan. For explicit deep options (poolSize), use " +
				"`suggest_files_deep`.",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				from: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
				verbose: z.boolean().optional(),
			},
			outputSchema: DeepSuggestResultSchema.shape,
		},
		logged("suggest_files", (p) => ({ task: p.task, path: p.path }), async ({ task, path, from, limit, stale, verbose }) => {
			const repoPath = path ?? process.cwd();
			const result = await suggestRepo(repoPath, task, {
				from,
				limit,
				stale,
				verbose,
				mode: "deep",
			});
			if (result.mode !== "deep") {
				throw new Error("suggestRepo returned non-deep result for suggest_files");
			}
			return {
				content: [{ type: "text" as const, text: renderDeepText(result) }],
				structuredContent: result,
			};
		}),
	);

	server.registerTool(
		"suggest_files_deep",
		{
			description:
				"Explicit deep search with pool size control. Same deep ranking as " +
				"suggest_files but accepts an additional poolSize parameter. Use when " +
				"you need to tune the candidate pool (e.g. larger pool for broad " +
				"queries on big repos).",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				from: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
				poolSize: z.number().int().positive().max(200).optional(),
				verbose: z.boolean().optional(),
			},
			outputSchema: DeepSuggestResultSchema.shape,
		},
		logged("suggest_files_deep", (p) => ({ task: p.task, path: p.path, poolSize: p.poolSize }), async ({ task, path, from, limit, stale, poolSize, verbose }) => {
			const repoPath = path ?? process.cwd();
			const result = await suggestRepo(repoPath, task, {
				from,
				limit,
				stale,
				poolSize,
				verbose,
				mode: "deep",
			});
			if (result.mode !== "deep") {
				throw new Error("suggestRepo returned non-deep result for suggest_files_deep");
			}
			return {
				content: [{ type: "text" as const, text: renderDeepText(result) }],
				structuredContent: result,
			};
		}),
	);

	server.tool(
		"index_project",
		"Build or force-refresh the project index. Usually not needed — rehydrate_project handles freshness automatically. Use this to explicitly rebuild after large structural changes.",
		{ path: z.string().optional() },
		logged("index_project", (p) => ({ path: p.path }), async ({ path }) => {
			const repoPath = path ?? process.cwd();
			const cache = await indexRepo(repoPath);
			return {
				content: [
					{
						type: "text" as const,
						text: `Indexed ${cache.files.length} files and ${cache.docs.length} docs.`,
					},
				],
			};
		}),
	);

	server.tool(
		"blast_radius",
		"Analyze what functions and files are affected if a given function is changed. "
			+ "Returns callers organized by hop distance (direct, transitive) with export "
			+ "visibility. Use before modifying a function to understand risk and plan testing. "
			+ "For class methods, use Class.method format (e.g., 'Ranker.score').",
		{
			qualifiedName: z.string().min(1),
			file: z.string().min(1),
			path: z.string().optional(),
			maxHops: z.number().int().positive().optional(),
			stale: z.boolean().optional(),
		},
		logged("blast_radius", (p) => ({ qualifiedName: p.qualifiedName, file: p.file, path: p.path }), async ({ qualifiedName, file, path, maxHops, stale }) => {
			const repoPath = path ?? process.cwd();
			const { cache } = await rehydrateRepo(repoPath, { stale });
			const result = queryBlastRadius(
				{ qualifiedName, file },
				cache.calls ?? [],
				cache.functions ?? [],
				maxHops ? { maxHops } : undefined,
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			};
		}),
	);

	return server;
}

function renderDeepText(r: DeepSuggestResult): string {
	const lines: string[] = [];
	lines.push(`suggested files (deep) for: ${r.task}`);
	lines.push(
		`mode: deep · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs} · pool: ${r.poolSize}`,
	);
	if (r.staleMixedEvidence) {
		lines.push("warning: stale:true — ranking uses cached graph, snippets use current disk");
	}
	lines.push("");
	for (const [i, item] of r.results.entries()) {
		lines.push(`${i + 1}. ${item.path}  [${item.kind} · score ${item.score}]`);
		lines.push(`   reason: ${item.reason}`);
		if (item.contentHits && item.contentHits.length > 0) {
			lines.push("   content:");
			for (const h of item.contentHits) {
				lines.push(`     L${h.line}: ${h.snippet}`);
			}
		}
	}
	return lines.join("\n").trimEnd();
}

export async function startMcpServer(): Promise<void> {
	if (process.stdin.isTTY) {
		process.stderr.write(
			"[ai-cortex] MCP server uses stdio transport — it expects an MCP client\n" +
			"[ai-cortex] (Claude Code, Codex, etc.) to pipe JSON-RPC on stdin/stdout.\n" +
			"[ai-cortex] Running interactively is not useful. Press Ctrl+C to exit.\n",
		);
	}

	const server = createServer();
	const transport = new StdioServerTransport();

	const shutdown = async () => {
		process.stderr.write("[ai-cortex] shutting down MCP server\n");
		try {
			await server.close();
		} catch {
			// best-effort
		}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await server.connect(transport);
		process.stderr.write("[ai-cortex] MCP server started (stdio)\n");
	} catch (err) {
		process.stderr.write(
			`[ai-cortex] failed to start MCP server: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	}

	// Explicitly wait for stdin to close before returning.
	// Without this, the process may exit before serving any requests in
	// environments where stdin is not automatically ref'd by the transport
	// (see: github.com/modelcontextprotocol/typescript-sdk/issues/202).
	await new Promise<void>((resolve) => process.stdin.on("close", resolve));
	process.stderr.write("[ai-cortex] stdin closed, MCP server exiting\n");
}
