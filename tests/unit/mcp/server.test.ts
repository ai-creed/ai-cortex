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

async function makeClient(): Promise<any> {
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
		vi.mocked(rehydrateRepo).mockResolvedValue({
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
		vi.mocked(rehydrateRepo).mockResolvedValue({
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
		vi.mocked(rehydrateRepo).mockResolvedValue({
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

describe("suggest_files", () => {
	it("calls suggestRepo with mode:deep and returns deep-formatted text", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "deep",
			task: "persistence layer",
			from: null,
			cacheStatus: "fresh",
			durationMs: 12,
			poolSize: 60,
			results: [
				{
					path: "src/store.ts",
					kind: "file",
					score: 15,
					reason: "matched task terms in path: persistence",
					contentHits: [{ line: 5, snippet: "export function persistStore()" }],
				},
			],
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files",
			arguments: { task: "persistence layer", path: "/repo", limit: 3 },
		});

		expect(suggestRepo).toHaveBeenCalledWith("/repo", "persistence layer", {
			from: undefined,
			limit: 3,
			stale: undefined,
			mode: "deep",
		});
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("suggested files (deep) for: persistence layer");
		expect(text).toMatch(/src\/store\.ts\s+\[file · score 15\]/);
		expect(text).toContain("L5: export function persistStore()");
		// Deep output MUST NOT have an escalation hint.
		expect(text).not.toMatch(/^escalation hint: /m);
		expect(result.structuredContent).toBeDefined();
		expect((result.structuredContent as any).mode).toBe("deep");
	});

	it("returns isError for blank task without calling suggestRepo", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files",
			arguments: { task: "" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("blank");
		expect(suggestRepo).not.toHaveBeenCalled();
	});

	it("returns isError for non-positive limit without calling suggestRepo", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files",
			arguments: { task: "fix auth", limit: 0 },
		});

		expect(result.isError).toBe(true);
		expect(suggestRepo).not.toHaveBeenCalled();
	});

	it("returns isError result for RepoIdentityError", async () => {
		vi.mocked(suggestRepo).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files",
			arguments: { task: "fix auth" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("not a git repo");
	});

	it("returns isError result for IndexError", async () => {
		vi.mocked(suggestRepo).mockImplementation(() => {
			throw new IndexError("ranking failed");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files",
			arguments: { task: "fix auth" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("ranking failed");
	});
});

describe("suggest_files_deep", () => {
	it("calls suggestRepo with mode:deep and returns deep structuredContent + text", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "deep",
			task: "persistence layer",
			from: null,
			cacheStatus: "fresh",
			durationMs: 42,
			poolSize: 60,
			results: [
				{
					path: "src/store.ts",
					kind: "file",
					score: 15,
					reason: "matched task terms in path: persistence",
					contentHits: [{ line: 12, snippet: "export function persistStore()" }],
				},
			],
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_deep",
			arguments: { task: "persistence layer", path: "/repo", limit: 5, poolSize: 60 },
		});

		expect(suggestRepo).toHaveBeenCalledWith("/repo", "persistence layer", {
			from: undefined,
			limit: 5,
			stale: undefined,
			poolSize: 60,
			mode: "deep",
		});
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("suggested files (deep) for: persistence layer");
		expect(text).toMatch(/src\/store\.ts\s+\[file · score 15\]/);
		expect(text).toContain("L12: export function persistStore()");
		// Deep output MUST NOT have an escalation hint.
		expect(text).not.toMatch(/^escalation hint: /m);
		expect(result.structuredContent).toBeDefined();
		expect((result.structuredContent as any).mode).toBe("deep");
		expect((result.structuredContent as any).poolSize).toBe(60);
	});

	it("returns isError for blank task without calling suggestRepo", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_deep",
			arguments: { task: "" },
		});
		expect(result.isError).toBe(true);
		expect(suggestRepo).not.toHaveBeenCalled();
	});

	it("surfaces staleMixedEvidence warning line in text output", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "deep",
			task: "x",
			from: null,
			cacheStatus: "stale",
			durationMs: 3,
			poolSize: 60,
			staleMixedEvidence: true,
			results: [],
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_deep",
			arguments: { task: "x", path: "/repo", stale: true },
		});
		const text = (result.content[0] as any).text as string;
		expect(text).toMatch(/warning: stale:true/);
	});
});

describe("index_project", () => {
	it("calls indexRepo with given path and returns file and doc count", async () => {
		vi.mocked(indexRepo).mockResolvedValue({
			files: [
				{ path: "src/app.ts", kind: "file", contentHash: "h1" },
				{ path: "src/cli.ts", kind: "file", contentHash: "h2" },
			],
			docs: [{ path: "README.md", title: "App", body: "# App" }],
		} as any);

		const client = await makeClient();
		const result = await client.callTool({
			name: "index_project",
			arguments: { path: "/repo" },
		});

		expect(indexRepo).toHaveBeenCalledWith("/repo");
		const text = (result.content[0] as any).text as string;
		expect(text).toBe("Indexed 2 files and 1 docs.");
	});

	it("defaults path to process.cwd() when not provided", async () => {
		vi.mocked(indexRepo).mockResolvedValue({ files: [], docs: [] } as any);

		const client = await makeClient();
		await client.callTool({ name: "index_project", arguments: {} });

		expect(indexRepo).toHaveBeenCalledWith(process.cwd());
	});

	it("returns isError result for RepoIdentityError", async () => {
		vi.mocked(indexRepo).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "index_project",
			arguments: { path: "/x" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("not a git repo");
	});

	it("returns isError result for IndexError", async () => {
		vi.mocked(indexRepo).mockImplementation(() => {
			throw new IndexError("scan failed");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "index_project",
			arguments: { path: "/x" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("scan failed");
	});
});
