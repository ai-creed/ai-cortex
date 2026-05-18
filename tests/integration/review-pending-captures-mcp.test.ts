// tests/integration/review-pending-captures-mcp.test.ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distCli = path.resolve(
	fileURLToPath(import.meta.url),
	"../../../dist/src/cli.js",
);

describe("review_pending_captures over MCP", () => {
	it("is registered and returns a JSON array through the server", async () => {
		const transport = new StdioClientTransport({
			command: "node",
			args: [distCli, "mcp"],
		});
		const client = new Client(
			{ name: "rpc-test", version: "0.0.1" },
			{ capabilities: {} },
		);
		await client.connect(transport);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toContain("review_pending_captures");

			const res = await client.callTool({
				name: "review_pending_captures",
				// this repo's own worktree → repoKey resolves; result is a
				// (possibly empty) JSON array, proving worktreePath→repoKey
				// resolution + response shape end-to-end.
				arguments: { worktreePath: process.cwd(), limit: 5 },
			});
			const text = (res.content as { type: string; text: string }[])[0].text;
			expect(Array.isArray(JSON.parse(text))).toBe(true);
		} finally {
			await client.close();
			await new Promise<void>((r) => setTimeout(r, 200));
		}
	}, 15000);
});
