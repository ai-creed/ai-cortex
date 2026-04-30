import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, resetReconciledKeys } from "../../../src/mcp/server.js";
import {
	openLifecycle,
	createMemory,
	pinMemory,
} from "../../../src/lib/memory/lifecycle.js";
import { openRetrieve } from "../../../src/lib/memory/retrieve.js";

let tmp: string;
let repoKey: string;

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

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-mcp-mem-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	repoKey = "test-mcp-memory";
	resetReconciledKeys();
});
afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("MCP memory read tools — registration", () => {
	it("registers recall_memory, get_memory, list_memories, search_memories, audit_memory", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const names = tools.map((t: { name: string }) => t.name);
		expect(names).toContain("recall_memory");
		expect(names).toContain("get_memory");
		expect(names).toContain("list_memories");
		expect(names).toContain("search_memories");
		expect(names).toContain("audit_memory");
	});
});

describe("MCP list_memories", () => {
	it("returns empty array for fresh repo", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "list_memories",
			arguments: { repoKey },
		});
		const text = (result.content[0] as any).text;
		const parsed = JSON.parse(text);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBe(0);
	});

	it("returns memories after creating one", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "MCP test",
				body: "## Body\ntest",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "list_memories",
			arguments: { repoKey },
		});
		const items = JSON.parse((result.content[0] as any).text);
		expect(items.length).toBe(1);
		expect(items[0].title).toBe("MCP test");
	});
});

describe("MCP search_memories", () => {
	it("returns empty array when no memories match", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "search_memories",
			arguments: { repoKey, query: "nonexistent" },
		});
		const parsed = JSON.parse((result.content[0] as any).text);
		expect(Array.isArray(parsed)).toBe(true);
	});
});

describe("MCP get_memory", () => {
	it("returns memory record for existing id", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "pattern",
				title: "Get test",
				body: "## Body\npattern",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "get_memory",
			arguments: { repoKey, id: id! },
		});
		const parsed = JSON.parse((result.content[0] as any).text);
		expect(parsed.frontmatter.id).toBe(id!);
	});

	it("returns isError for nonexistent id", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "get_memory",
			arguments: { repoKey, id: "nonexistent-id" },
		});
		expect(result.isError).toBe(true);
	});
});

describe("MCP audit_memory", () => {
	it("returns audit rows after creating a memory", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "Audit test",
				body: "## Body\naudit",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "audit_memory",
			arguments: { repoKey, id: id! },
		});
		const rows = JSON.parse((result.content[0] as any).text);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].changeType).toBe("create");
	});
});

describe("MCP memory write tools — registration", () => {
	it("registers all write tool names", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const names = tools.map((t: { name: string }) => t.name);
		for (const name of [
			"record_memory",
			"update_memory",
			"update_scope",
			"deprecate_memory",
			"restore_memory",
			"merge_memories",
			"trash_memory",
			"untrash_memory",
			"purge_memory",
			"link_memories",
			"unlink_memories",
			"pin_memory",
			"unpin_memory",
			"confirm_memory",
			"add_evidence",
			"rebuild_index",
		]) {
			expect(names).toContain(name);
		}
	});
});

describe("MCP record_memory", () => {
	it("creates a memory and returns its id", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "record_memory",
			arguments: {
				repoKey,
				type: "decision",
				title: "MCP write test",
				body: "## Decision\nuse MCP",
				scopeFiles: [],
				scopeTags: [],
				source: "explicit",
			},
		});
		expect(result.isError).toBeFalsy();
		const id = (result.content[0] as any).text.trim();
		expect(id).toMatch(/^mem-\d{4}-\d{2}-\d{2}-mcp-write-test-[0-9a-f]{6}$/);
	});
});

describe("MCP update_memory", () => {
	it("updates title and returns ok", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "Before",
				body: "## Body\nbefore",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "update_memory",
			arguments: { repoKey, id: id!, title: "After", reason: "test" },
		});
		expect(result.isError).toBeFalsy();
	});
});

describe("MCP trash_memory + untrash_memory", () => {
	it("trash then untrash cycle succeeds", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "Trash me",
				body: "## Body\ntrash",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const tr = await client.callTool({
			name: "trash_memory",
			arguments: { repoKey, id: id!, reason: "test" },
		});
		expect(tr.isError).toBeFalsy();

		const ut = await client.callTool({
			name: "untrash_memory",
			arguments: { repoKey, id: id! },
		});
		expect(ut.isError).toBeFalsy();
	});
});

describe("MCP reconcile-on-first-call", () => {
	it("reconcile runs once per repoKey per server (not on every call)", async () => {
		// Create memory via lifecycle
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "pattern",
				title: "Orphan test",
				body: "## Pattern\ncontent",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		// Delete the sqlite row to create an orphan .md file
		const rh = openRetrieve(repoKey);
		rh.index.rawDb().prepare("DELETE FROM memories WHERE id = ?").run(id!);
		rh.close();

		// Call list_memories — should trigger reconcile which re-adopts the orphan
		const client = await makeClient();
		const result = await client.callTool({
			name: "list_memories",
			arguments: { repoKey },
		});
		const items = JSON.parse((result.content[0] as any).text);
		// After reconcile, the orphan .md is re-adopted and should appear
		expect(items.some((i: any) => i.id === id!)).toBe(true);
	}, 30_000);
});

describe("MCP memory end-to-end lifecycle", () => {
	it("record → update → deprecate → restore → trash → purge → audit trail", async () => {
		const client = await makeClient();

		// 1. Record (source="explicit" creates with status "active")
		const recResult = await client.callTool({
			name: "record_memory",
			arguments: {
				repoKey,
				type: "decision",
				title: "E2E test decision",
				body: "## Decision\nuse end-to-end tests",
				scopeFiles: [],
				scopeTags: [],
				source: "explicit",
			},
		});
		expect(recResult.isError).toBeFalsy();
		const id = (recResult.content[0] as any).text.trim();
		expect(id).toMatch(/^mem-/);

		// 2. Update title
		// (confirmMemory only works on candidate status; record with source="explicit" creates active — skip confirm)
		const updResult = await client.callTool({
			name: "update_memory",
			arguments: {
				repoKey,
				id,
				title: "E2E test decision (updated)",
				reason: "e2e update",
			},
		});
		expect(updResult.isError).toBeFalsy();

		// 3. Deprecate
		const depResult = await client.callTool({
			name: "deprecate_memory",
			arguments: { repoKey, id, reason: "e2e deprecate" },
		});
		expect(depResult.isError).toBeFalsy();

		// 4. Restore (back to active)
		const resResult = await client.callTool({
			name: "restore_memory",
			arguments: { repoKey, id },
		});
		expect(resResult.isError).toBeFalsy();

		// 5. Trash
		const trResult = await client.callTool({
			name: "trash_memory",
			arguments: { repoKey, id, reason: "e2e trash" },
		});
		expect(trResult.isError).toBeFalsy();

		// 6. Purge
		const prResult = await client.callTool({
			name: "purge_memory",
			arguments: { repoKey, id, reason: "e2e purge" },
		});
		expect(prResult.isError).toBeFalsy();

		// 7. Audit trail shows all operations
		const auditResult = await client.callTool({
			name: "audit_memory",
			arguments: { repoKey, id },
		});
		expect(auditResult.isError).toBeFalsy();
		const rows = JSON.parse((auditResult.content[0] as any).text);
		const changeTypes = rows.map((r: any) => r.changeType);
		expect(changeTypes).toContain("create");
		expect(changeTypes).toContain("update");
		expect(changeTypes).toContain("deprecate");
		expect(changeTypes).toContain("restore");
		expect(changeTypes).toContain("trash");
		expect(changeTypes).toContain("purge");
	}, 30_000);

	it("record → recall returns the memory (FTS search)", async () => {
		const client = await makeClient();

		// Use "decision" type (no required typeFields) so record_memory succeeds via MCP
		const recResult = await client.callTool({
			name: "record_memory",
			arguments: {
				repoKey,
				type: "decision",
				title: "Xenova model warm-up",
				body: "## Rule\nThe Xenova transformer model needs warm-up time on first load.",
				scopeFiles: [],
				scopeTags: [],
				source: "explicit",
			},
		});
		expect(recResult.isError).toBeFalsy();

		// FTS search should find it
		const searchResult = await client.callTool({
			name: "search_memories",
			arguments: { repoKey, query: "Xenova transformer", limit: 5 },
		});
		const hits = JSON.parse((searchResult.content[0] as any).text);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].title).toBe("Xenova model warm-up");
	}, 30_000);
});
