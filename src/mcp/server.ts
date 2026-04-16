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
import type { FastSuggestResult, DeepSuggestResult } from "../lib/suggest.js";
import { FastSuggestResultSchema, DeepSuggestResultSchema } from "../lib/suggest.js";

// Keep in sync with package.json "version".
const SERVER_VERSION = "0.0.0-phase0";

export function createServer(): McpServer {
	const server = new McpServer({ name: "ai-cortex", version: SERVER_VERSION });

	server.tool(
		"rehydrate_project",
		"Load project context for the current session. Call this once at the start of any session when working in a git repository. Returns a markdown briefing covering project structure, key files, entry points, and recent changes.",
		{ path: z.string().optional() },
		async ({ path }) => {
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
		},
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
			},
			outputSchema: DeepSuggestResultSchema.shape,
		},
		async ({ task, path, from, limit, stale }) => {
			const repoPath = path ?? process.cwd();
			const result = await suggestRepo(repoPath, task, {
				from,
				limit,
				stale,
				mode: "deep",
			});
			if (result.mode !== "deep") {
				throw new Error("suggestRepo returned non-deep result for suggest_files");
			}
			return {
				content: [{ type: "text" as const, text: renderDeepText(result) }],
				structuredContent: result,
			};
		},
	);

	server.registerTool(
		"suggest_files_deep",
		{
			description:
				"Deeper file search. Superset of suggest_files: adds trigram fuzzy " +
				"match and content scan over top candidates. Slower (~300ms typical, " +
				"700ms max). Use when `suggest_files` returns low-relevance results.",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				from: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
				poolSize: z.number().int().positive().max(200).optional(),
			},
			outputSchema: DeepSuggestResultSchema.shape,
		},
		async ({ task, path, from, limit, stale, poolSize }) => {
			const repoPath = path ?? process.cwd();
			const result = await suggestRepo(repoPath, task, {
				from,
				limit,
				stale,
				poolSize,
				mode: "deep",
			});
			if (result.mode !== "deep") {
				throw new Error("suggestRepo returned non-deep result for suggest_files_deep");
			}
			return {
				content: [{ type: "text" as const, text: renderDeepText(result) }],
				structuredContent: result,
			};
		},
	);

	server.tool(
		"index_project",
		"Build or force-refresh the project index. Usually not needed — rehydrate_project handles freshness automatically. Use this to explicitly rebuild after large structural changes.",
		{ path: z.string().optional() },
		async ({ path }) => {
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
		},
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
		async ({ qualifiedName, file, path, maxHops, stale }) => {
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
		},
	);

	return server;
}

function renderFastText(r: FastSuggestResult): string {
	const lines: string[] = [];
	lines.push(`suggested files for: ${r.task}`);
	lines.push(`mode: fast · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs}`);
	lines.push("");
	for (const [i, item] of r.results.entries()) {
		lines.push(`${i + 1}. ${item.path}  [${item.kind} · score ${item.score}]`);
		lines.push(`   reason: ${item.reason}`);
	}
	lines.push("");
	lines.push(escalationHint(r));
	return lines.join("\n").trimEnd();
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

function escalationHint(r: FastSuggestResult): string {
	const topScore = r.results[0]?.score ?? 0;
	const fileCount = r.results.filter((x) => x.kind === "file").length;
	const reasons: string[] = [];
	if (topScore < 10) reasons.push(`top score=${topScore} is low`);
	if (fileCount === 0) reasons.push("no code files in top-N");
	const summary =
		reasons.length > 0
			? `consider suggest_files_deep (${reasons.join("; ")})`
			: "deep unlikely to help";
	return `escalation hint: top score=${topScore}, ${fileCount} code files in top-${r.results.length} — ${summary}`;
}

export async function startMcpServer(): Promise<void> {
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Explicitly wait for stdin to close before returning.
	// Without this, the process may exit before serving any requests in
	// environments where stdin is not automatically ref'd by the transport
	// (see: github.com/modelcontextprotocol/typescript-sdk/issues/202).
	await new Promise<void>((resolve) => process.stdin.on("close", resolve));
}
