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
import type { DeepSuggestResult, SemanticSuggestResult } from "../lib/suggest.js";
import { DeepSuggestResultSchema, SemanticSuggestResultSchema } from "../lib/suggest.js";
import { searchHistory } from "../lib/history/search.js";
import { captureSession } from "../lib/history/capture.js";
import { isHistoryEnabled } from "../lib/history/config.js";
import { detectCurrentSession, resolveTranscriptPath } from "../lib/history/session-detect.js";
import { resolveRepoIdentity } from "../lib/repo-identity.js";
import { getProvider, MODEL_NAME } from "../lib/embed-provider.js";

// Keep in sync with package.json "version".
const SERVER_VERSION = "0.3.0-beta.2";

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

let noticeSent = false;
export function resetFirstCallNoticeForTest(): void { noticeSent = false; }
export function hasNoticeBeenSent(): boolean { return noticeSent; }

function maybeNotice(): string {
	if (noticeSent) return "";
	noticeSent = true;
	if (isHistoryEnabled()) {
		return "<!-- history: capture active. disable with AI_CORTEX_HISTORY=0 or 'ai-cortex history off'. install hooks for best results: 'ai-cortex history install-hooks'. -->\n";
	}
	return "<!-- history: capture disabled. enable with AI_CORTEX_HISTORY=1 or 'ai-cortex history on'. -->\n";
}

async function embedQueryWithProvider(q: string): Promise<{ vector: Float32Array; modelName: string }> {
	const provider = await getProvider();
	const [vector] = await provider.embed([q]);
	return { vector, modelName: MODEL_NAME };
}

async function lazyCaptureCurrentSession(repoKey: string, cwd: string): Promise<void> {
	if (!isHistoryEnabled()) return;
	const detected = detectCurrentSession({ cwd });
	if (!detected) return;
	const transcriptPath = resolveTranscriptPath(cwd, detected.sessionId);
	if (!fs.existsSync(transcriptPath)) return;
	await captureSession({ repoKey, sessionId: detected.sessionId, transcriptPath, embed: true });
}

export type SearchHistoryArgs = {
	query: string;
	sessionId?: string;
	scope?: "session" | "project";
	limit?: number;
	path?: string;
};

export async function handleSearchHistory(args: SearchHistoryArgs): Promise<{ content: { type: "text"; text: string }[] }> {
	const cwd = args.path ?? process.cwd();
	let repoKey: string;
	try {
		repoKey = resolveRepoIdentity(cwd).repoKey;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{
				type: "text" as const,
				text: `${maybeNotice()}history: not in a git repo (${msg}). search_history requires a git repo for cache scoping.`,
			}],
		};
	}

	if (!args.sessionId) {
		try {
			await lazyCaptureCurrentSession(repoKey, cwd);
		} catch (err) {
			process.stderr.write(`[ai-cortex] history: lazy capture failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	const result = await searchHistory({
		repoKey,
		cwd,
		query: args.query,
		sessionId: args.sessionId,
		scope: args.scope,
		limit: args.limit,
		embedQuery: embedQueryWithProvider,
	});

	const lines: string[] = [maybeNotice()];
	if (result.error === "session-not-detected") {
		lines.push("could not detect current session; pass sessionId, set AI_CORTEX_SESSION_ID, or use scope=project");
	} else if (result.hits.length === 0) {
		lines.push("(no results)");
	} else {
		for (const h of result.hits) {
			lines.push(`[session ${h.sessionId} · ${h.kind}${h.turn !== null ? ` · turn ${h.turn}` : ""} · score ${h.score.toFixed(2)}]`);
			lines.push(`> ${h.text.slice(0, 200)}`);
			lines.push("");
		}
		if (result.broadened) {
			lines.push("(broadened to project scope: current session had no matches)");
		}
	}
	return { content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }] };
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
				"USE FIRST for file discovery — call this before Grep or Glob when you " +
				"need to find which files are relevant to a task. Returns ranked files " +
				"using path tokens, function names, import/call graph, trigram fuzzy " +
				"match, and content scan. Fall back to Grep/Glob only for: exact-string " +
				"lookup of a known symbol, verifying edits, or when `suggest_files` " +
				"returns nothing useful. For explicit poolSize, use `suggest_files_deep`.",
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

	server.registerTool(
		"suggest_files_semantic",
		{
			description:
				"Rank files by semantic similarity when the task is conceptual or " +
				"fuzzy and keyword/graph ranking (`suggest_files`) returns nothing " +
				"useful. Uses sentence embeddings (Xenova/all-MiniLM-L6-v2, 384-dim). " +
				"First call downloads ~23 MB model; subsequent calls are fast.",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
			},
			outputSchema: SemanticSuggestResultSchema.shape,
		},
		logged("suggest_files_semantic", (p) => ({ task: p.task, path: p.path }), async ({ task, path, limit, stale }) => {
			const repoPath = path ?? process.cwd();
			const result = await suggestRepo(repoPath, task, {
				limit,
				stale,
				mode: "semantic",
			});
			if (result.mode !== "semantic") {
				throw new Error("suggestRepo returned non-semantic result for suggest_files_semantic");
			}
			return {
				content: [{ type: "text" as const, text: renderSemanticText(result) }],
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

	server.registerTool(
		"search_history",
		{
			description:
				"Search compacted history of past agent sessions in this project. " +
				"Defaults to the current session. Use this to recover context lost to harness compaction " +
				"(decisions, file paths, user corrections, prior discussion). " +
				"Auto-broadens to the whole project if the current-session search returns nothing.",
			inputSchema: {
				query: z.string().min(1, "query must not be blank"),
				sessionId: z.string().optional(),
				scope: z.enum(["session", "project"]).optional(),
				limit: z.number().int().positive().max(50).optional(),
				path: z.string().optional(),
			},
		},
		logged(
			"search_history",
			(p: SearchHistoryArgs) => ({ query: p.query, scope: p.scope, sessionId: p.sessionId }),
			handleSearchHistory,
		),
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

// Intentional copy of cli.ts renderSemanticText — keeps server and CLI independent.
function renderSemanticText(r: SemanticSuggestResult): string {
	const lines: string[] = [];
	lines.push(`suggested files (semantic) for: ${r.task}`);
	lines.push(
		`mode: semantic · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs} · pool: ${r.poolSize}`,
	);
	lines.push("");
	for (const [i, item] of r.results.entries()) {
		lines.push(`${i + 1}. ${item.path}  [${item.kind} · score ${item.score.toFixed(3)}]`);
		lines.push(`   reason: ${item.reason}`);
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
