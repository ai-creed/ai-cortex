// src/mcp/server.ts
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
} from "../lib/index.js";

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

	server.tool(
		"suggest_files",
		"Get a ranked list of files relevant to a specific task. Call this when you have a clear task before reading the codebase — it surfaces the most relevant files so you know where to start.",
		{
			task: z.string().min(1, "task must not be blank"),
			path: z.string().optional(),
			from: z.string().optional(),
			limit: z.number().int().positive().optional(),
			stale: z.boolean().optional(),
		},
		async ({ task, path, from, limit, stale }) => {
			const repoPath = path ?? process.cwd();
			const result = await suggestRepo(repoPath, task, { from, limit, stale });
			const lines = [`suggested files for: ${result.task}`, ""];
			for (const [i, item] of result.results.entries()) {
				lines.push(`${i + 1}. ${item.path}`);
				lines.push(`   reason: ${item.reason}`);
				lines.push("");
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
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

	return server;
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
