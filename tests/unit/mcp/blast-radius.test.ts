import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../../../src/mcp/server.js";
import * as coordinator from "../../../src/lib/cache-coordinator.js";
import * as blast from "../../../src/lib/blast-radius.js";
import * as rehydrate from "../../../src/lib/rehydrate.js";

const SESSION_CACHE_HOME = process.env.AI_CORTEX_CACHE_HOME;
let tmp: string;
let repo: string;

function git(...a: string[]): void {
	execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
}
async function makeClient(): Promise<Client> {
	const server = createServer();
	const [st, ct] = InMemoryTransport.createLinkedPair();
	await server.connect(st);
	const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
	await client.connect(ct);
	return client;
}
function callBlast(
	client: Client,
	args: Record<string, unknown>,
): Promise<{ content: Array<{ text: string }> }> {
	return client.callTool({
		name: "blast_radius",
		arguments: { qualifiedName: "bar", file: "src/b.ts", path: repo, ...args },
	}) as Promise<{ content: Array<{ text: string }> }>;
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-blast-mcp-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	repo = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-blast-repo-")),
	);
	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({ name: "p", version: "1.0.0" }),
	);
	fs.writeFileSync(path.join(repo, "src/b.ts"), "export function bar(){return 1;}\n");
	fs.writeFileSync(
		path.join(repo, "src/a.ts"),
		'import { bar } from "./b.js";\nexport function foo(){return bar();}\n',
	);
	git("init", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-m", "i");
});
afterEach(() => {
	process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
	vi.restoreAllMocks();
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("MCP blast_radius handler", () => {
	it("uses ensureFreshDb + queryBlastRadiusDb (NOT rehydrateRepo) and returns callers", async () => {
		const ensureSpy = vi.spyOn(coordinator, "ensureFreshDb");
		const qSpy = vi.spyOn(blast, "queryBlastRadiusDb");
		const rehydSpy = vi.spyOn(rehydrate, "rehydrateRepo");

		const client = await makeClient();
		const res = await callBlast(client, {});
		const parsed = JSON.parse(res.content[0]!.text) as {
			tiers: Array<{ hits: Array<{ qualifiedName: string }> }>;
		};
		expect(
			parsed.tiers.flatMap((t) => t.hits.map((h) => h.qualifiedName)),
		).toContain("foo");

		expect(ensureSpy).toHaveBeenCalled();
		expect(qSpy).toHaveBeenCalled();
		expect(rehydSpy).not.toHaveBeenCalled(); // proves the swap off rehydrateRepo
	});

	it("covers reindexed/fresh/stale through the real handler", async () => {
		const ensureSpy = vi.spyOn(coordinator, "ensureFreshDb");
		const client = await makeClient();

		await callBlast(client, {}); // cold
		expect((await ensureSpy.mock.results.at(-1)!.value).cacheStatus).toBe(
			"reindexed",
		);
		await callBlast(client, {}); // warm clean
		expect((await ensureSpy.mock.results.at(-1)!.value).cacheStatus).toBe(
			"fresh",
		);
		fs.appendFileSync(path.join(repo, "src/a.ts"), "\nexport const z = 1;\n");
		await callBlast(client, { stale: true }); // dirty + stale
		expect((await ensureSpy.mock.results.at(-1)!.value).cacheStatus).toBe(
			"stale",
		);
	});
});
