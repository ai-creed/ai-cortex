import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/mcp/server.js";
import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import {
	openLifecycle,
	createMemory,
} from "../../../src/lib/memory/lifecycle.js";
import { readMemoryFile } from "../../../src/lib/memory/store.js";
import { mkRepoKey, cleanupRepo } from "../../helpers/memory-fixtures.js";

describe("gotcha severity defaulting at the MCP layer", () => {
	let cleanupKey: string;
	let repoKey: string;
	beforeEach(async () => {
		cleanupKey = await mkRepoKey("mcp-write-defaults"); // sets AI_CORTEX_CACHE_HOME
		repoKey = resolveRepoIdentity(process.cwd()).repoKey;
	});
	afterEach(async () => {
		await cleanupRepo(cleanupKey);
	});

	async function callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const server = createServer();
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(st), client.connect(ct)]);
		try {
			const res = await client.callTool({
				name,
				arguments: { worktreePath: process.cwd(), ...args },
			});
			expect(res.isError ?? false).toBe(false);
			return (res.content as { type: string; text: string }[])[0]!.text.trim();
		} finally {
			await client.close();
		}
	}

	it("record_memory defaults gotcha severity to warning", async () => {
		const id = await callTool("record_memory", {
			type: "gotcha",
			title: "stale daemon hang",
			body: "Symptom: tests hang. Cause: stale daemon.",
		});
		const rec = await readMemoryFile(repoKey, id, "memories");
		expect(rec.frontmatter.typeFields).toEqual({ severity: "warning" });
	});

	it("rewrite_memory to gotcha defaults severity to warning", async () => {
		let capId = "";
		const lc = await openLifecycle(repoKey);
		try {
			capId = await createMemory(lc, {
				type: "capture",
				title: "raw capture",
				body: "always check the daemon before tests because stale ones hang the suite",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
		} finally {
			lc.close();
		}
		await callTool("rewrite_memory", {
			id: capId,
			title: "stale daemons hang the suite",
			body: "Symptom: suite hangs. Cause: stale daemon. Workaround: kill before run.",
			scopeFiles: [],
			scopeTags: [],
			type: "gotcha",
		});
		const rec = await readMemoryFile(repoKey, capId, "memories");
		expect(rec.frontmatter.type).toBe("gotcha");
		expect(rec.frontmatter.status).toBe("active");
		expect(rec.frontmatter.typeFields).toEqual({ severity: "warning" });
	});
});
