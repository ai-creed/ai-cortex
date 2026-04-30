// tests/unit/mcp/server.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import {
	rehydrateRepo,
	suggestRepo,
	indexRepo,
	queryBlastRadius,
} from "../../../src/lib/index.js";
import { IndexError, RepoIdentityError } from "../../../src/lib/models.js";
import { createServer } from "../../../src/mcp/server.js";

const _require = createRequire(import.meta.url);

vi.mock("../../../src/lib/index.js");
vi.mock("node:fs");

async function makeClient(): Promise<any> {
	const server = createServer();
	const [serverTransport, clientTransport] =
		InMemoryTransport.createLinkedPair();
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
		vi.mocked(fs.readFileSync).mockReturnValue(
			"# Project Briefing\n..." as any,
		);

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
					contentHits: [
						{ line: 12, snippet: "export function persistStore()" },
					],
				},
			],
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_deep",
			arguments: {
				task: "persistence layer",
				path: "/repo",
				limit: 5,
				poolSize: 60,
			},
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

describe("suggest_files_semantic", () => {
	it("calls suggestRepo with mode:semantic and returns semantic-formatted text", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "semantic",
			task: "vector search",
			from: null,
			cacheStatus: "fresh",
			durationMs: 88,
			poolSize: 50,
			results: [
				{
					path: "src/embedder.ts",
					kind: "file",
					score: 0.912,
					reason: "high cosine similarity to query",
				},
			],
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_semantic",
			arguments: { task: "vector search", path: "/repo", limit: 5 },
		});

		expect(suggestRepo).toHaveBeenCalledWith("/repo", "vector search", {
			limit: 5,
			stale: undefined,
			mode: "semantic",
		});
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("suggested files (semantic) for: vector search");
		expect(text).toContain("mode: semantic");
		expect(text).toContain("cacheStatus: fresh");
		expect(text).toMatch(/src\/embedder\.ts\s+\[file · score 0\.912\]/);
		expect(text).toContain("high cosine similarity to query");
		expect(result.structuredContent).toBeDefined();
		expect((result.structuredContent as any).mode).toBe("semantic");
		expect((result.structuredContent as any).poolSize).toBe(50);
	});

	it("returns isError for blank task without calling suggestRepo", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_semantic",
			arguments: { task: "" },
		});

		expect(result.isError).toBe(true);
		expect(suggestRepo).not.toHaveBeenCalled();
	});

	it("defaults path to process.cwd() when not provided", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "semantic",
			task: "auth",
			from: null,
			cacheStatus: "fresh",
			durationMs: 10,
			poolSize: 50,
			results: [],
		});

		const client = await makeClient();
		await client.callTool({
			name: "suggest_files_semantic",
			arguments: { task: "auth" },
		});

		expect(suggestRepo).toHaveBeenCalledWith(process.cwd(), "auth", {
			limit: undefined,
			stale: undefined,
			mode: "semantic",
		});
	});

	it("throws if suggestRepo returns non-semantic mode", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "deep",
			task: "auth",
			from: null,
			cacheStatus: "fresh",
			durationMs: 5,
			poolSize: 60,
			results: [],
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_semantic",
			arguments: { task: "auth", path: "/repo" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("non-semantic");
	});

	it("returns isError result for RepoIdentityError", async () => {
		vi.mocked(suggestRepo).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		const client = await makeClient();
		const result = await client.callTool({
			name: "suggest_files_semantic",
			arguments: { task: "auth" },
		});

		expect(result.isError).toBe(true);
		expect((result.content[0] as any).text).toContain("not a git repo");
	});
});

describe("SERVER_VERSION", () => {
	it("matches package.json version", async () => {
		const client = await makeClient();
		const capturedServerVersion = client.getServerVersion()?.version;
		const pkg = _require("../../../package.json") as { version: string };
		expect(capturedServerVersion).toBe(pkg.version);
	});
});

describe("tool call logging", () => {
	let stderrSpy: any;

	beforeEach(() => {
		stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((() => true) as any);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("logs successful rehydrate_project call with duration", async () => {
		vi.mocked(rehydrateRepo).mockResolvedValue({
			briefingPath: "/cache/key.md",
			cacheStatus: "fresh",
			cache: {} as any,
		});
		vi.mocked(fs.readFileSync).mockReturnValue("# Briefing" as any);

		const client = await makeClient();
		await client.callTool({
			name: "rehydrate_project",
			arguments: { path: "/repo" },
		});

		const logged = stderrSpy.mock.calls.map((c: any) => String(c[0])).join("");
		expect(logged).toMatch(/\[ai-cortex\] tool=rehydrate_project/);
		expect(logged).toMatch(/path=\/repo/);
		expect(logged).toMatch(/dur=\d+ms/);
		expect(logged).toMatch(/status=ok/);
	});

	it("logs successful suggest_files call with task", async () => {
		vi.mocked(suggestRepo).mockResolvedValue({
			mode: "deep",
			task: "auth fix",
			from: null,
			cacheStatus: "fresh",
			durationMs: 10,
			poolSize: 60,
			results: [],
		});

		const client = await makeClient();
		await client.callTool({
			name: "suggest_files",
			arguments: { task: "auth fix", path: "/repo" },
		});

		const logged = stderrSpy.mock.calls.map((c: any) => String(c[0])).join("");
		expect(logged).toMatch(/\[ai-cortex\] tool=suggest_files/);
		expect(logged).toMatch(/task=auth fix/);
		expect(logged).toMatch(/dur=\d+ms/);
		expect(logged).toMatch(/status=ok/);
	});

	it("logs error status when tool handler throws", async () => {
		vi.mocked(rehydrateRepo).mockImplementation(() => {
			throw new RepoIdentityError("not a git repo");
		});

		const client = await makeClient();
		await client.callTool({
			name: "rehydrate_project",
			arguments: { path: "/x" },
		});

		const logged = stderrSpy.mock.calls.map((c: any) => String(c[0])).join("");
		expect(logged).toMatch(/\[ai-cortex\] tool=rehydrate_project/);
		expect(logged).toMatch(/status=error/);
		expect(logged).toMatch(/err="not a git repo"/);
	});

	it("logs index_project call", async () => {
		vi.mocked(indexRepo).mockResolvedValue({
			files: [{ path: "a.ts", kind: "file", contentHash: "h" }],
			docs: [],
		} as any);

		const client = await makeClient();
		await client.callTool({
			name: "index_project",
			arguments: { path: "/repo" },
		});

		const logged = stderrSpy.mock.calls.map((c: any) => String(c[0])).join("");
		expect(logged).toMatch(/\[ai-cortex\] tool=index_project/);
		expect(logged).toMatch(/status=ok/);
	});

	it("logs blast_radius call with qualifiedName", async () => {
		vi.mocked(rehydrateRepo).mockResolvedValue({
			briefingPath: "/cache/key.md",
			cacheStatus: "fresh",
			cache: { calls: [], functions: [] } as any,
		});
		vi.mocked(queryBlastRadius).mockReturnValue({
			target: { qualifiedName: "myFn", file: "src/a.ts" },
			totalAffected: 0,
			confidence: "full",
			tiers: [],
		} as any);

		const client = await makeClient();
		await client.callTool({
			name: "blast_radius",
			arguments: { qualifiedName: "myFn", file: "src/a.ts", path: "/repo" },
		});

		const logged = stderrSpy.mock.calls.map((c: any) => String(c[0])).join("");
		expect(logged).toMatch(/\[ai-cortex\] tool=blast_radius/);
		expect(logged).toMatch(/qualifiedName=myFn/);
		expect(logged).toMatch(/status=ok/);
	});
});
