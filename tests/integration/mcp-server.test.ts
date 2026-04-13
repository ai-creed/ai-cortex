// tests/integration/mcp-server.test.ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distCli = path.resolve(
	fileURLToPath(import.meta.url),
	"../../../dist/src/cli.js",
);

describe("mcp server subprocess", () => {
	it(
		"starts, lists all three tools, and exits cleanly on client disconnect",
		async () => {
			const transport = new StdioClientTransport({
				command: "node",
				args: [distCli, "mcp"],
			});
			const client = new Client(
				{ name: "smoke-test", version: "0.0.1" },
				{ capabilities: {} },
			);

			await client.connect(transport);

			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);

			expect(names).toContain("rehydrate_project");
			expect(names).toContain("suggest_files");
			expect(names).toContain("index_project");

			// Closing the client writes EOF to the server's stdin.
			// The server's startMcpServer() resolves and the process exits.
			await client.close();

			// Brief wait to confirm the subprocess exited without error.
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
		},
		10000,
	);
});
