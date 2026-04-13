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

export function createServer(): McpServer {
	const server = new McpServer({ name: "ai-cortex", version: "1.0.0" });

	server.tool(
		"rehydrate_project",
		"Load project context for the current session. Call this once at the start of any session when working in a git repository. Returns a markdown briefing covering project structure, key files, entry points, and recent changes.",
		{ path: z.string().optional() },
		async ({ path }) => {
			const repoPath = path ?? process.cwd();
			const result = rehydrateRepo(repoPath);
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
