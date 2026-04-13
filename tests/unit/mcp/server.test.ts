// tests/unit/mcp/server.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import { rehydrateRepo, suggestRepo, indexRepo } from "../../../src/lib/index.js";
import { IndexError, RepoIdentityError } from "../../../src/lib/models.js";
import { createServer } from "../../../src/mcp/server.js";

vi.mock("../../../src/lib/index.js");
vi.mock("node:fs");

async function makeClient() {
	const server = createServer();
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "test-client", version: "0.0.1" },
		{ capabilities: {} },
	);
	await client.connect(clientTransport);
	return client;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("rehydrate_project", () => {
	it("calls rehydrateRepo with given path and returns briefing text", async () => {
		vi.mocked(rehydrateRepo).mockReturnValue({
			briefingPath: "/cache/key.md",
			cacheStatus: "fresh",
			cache: {} as any,
		});
		vi.mocked(fs.readFileSync).mockReturnValue("# Project Briefing\n..." as any);

		const client = await makeClient();
		const result = await client.callTool({
			name: "rehydrate_project",
			arguments: { path: "/repo" },
		});

		expect(rehydrateRepo).toHaveBeenCalledWith("/repo");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("# Project Briefing"),
		});
	});

	it("includes cache status comment at the top of the output", async () => {
		vi.mocked(rehydrateRepo).mockReturnValue({
			briefingPath: "/cache/key.md",
			cacheStatus: "reindexed",
			cache: {} as any,
		});
		vi.mocked(fs.readFileSync).mockReturnValue("# Briefing" as any);

		const client = await makeClient();
		const result = await client.callTool({
			name: "rehydrate_project",
			arguments: { path: "/repo" },
		});

		const text = (result.content[0] as any).text as string;
		expect(text).toMatch(/^<!-- cache: reindexed -->/);
	});

	it("defaults path to process.cwd() when not provided", async () => {
		vi.mocked(rehydrateRepo).mockReturnValue({
			briefingPath: "/cache/key.md",
			cacheStatus: "fresh",
			cache: {} as any,
		});
		vi.mocked(fs.readFileSync).mockReturnValue("# Briefing" as any);

		const client = await makeClient();
		await client.callTool({ name: "rehydrate_project", arguments: {} });

		expect(rehydrateRepo).toHaveBeenCalledWith(process.cwd());
	});

	it("returns isError result for RepoIdentityError", async () => {
		vi.mocked(rehydrateRepo).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "rehydrate_project",
			arguments: { path: "/x" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("not a git repo");
	});

	it("returns isError result for IndexError", async () => {
		vi.mocked(rehydrateRepo).mockImplementation(() => {
			throw new IndexError("read failed");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "rehydrate_project",
			arguments: { path: "/repo" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("read failed");
	});
});
