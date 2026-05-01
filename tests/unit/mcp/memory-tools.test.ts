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
} from "../../../src/lib/memory/lifecycle.js";
import { openRetrieve } from "../../../src/lib/memory/retrieve.js";
import { writeSession } from "../../../src/lib/history/store.js";
import { mkRepoKey, cleanupRepo } from "../../helpers/memory-fixtures.js";

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

	it("registers sweep_aging and promote_to_global", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const names = tools.map((t: { name: string }) => t.name);
		expect(names).toContain("sweep_aging");
		expect(names).toContain("promote_to_global");
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

describe("MCP record_memory with globalScope=true", () => {
  it("writes to global store when globalScope=true", async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: "record_memory",
      arguments: {
        repoKey,
        type: "gotcha",
        title: "global gotcha via MCP",
        body: "## Body\nglobal content",
        scopeFiles: [],
        scopeTags: [],
        source: "explicit",
        typeFields: { severity: "info" },
        globalScope: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const globalId = (result.content[0] as any).text.trim();
    expect(globalId).toMatch(/^mem-/);

    // Verify it landed in global store, not project
    const { openRetrieve } = await import("../../../src/lib/memory/retrieve.js");
    const globalRh = openRetrieve("global");
    try {
      const row = globalRh.index.getMemory(globalId);
      expect(row).toBeDefined();
      expect(row?.title).toBe("global gotcha via MCP");
    } finally {
      globalRh.close();
    }

    // Verify it did NOT land in project store
    const projectRh = openRetrieve(repoKey);
    try {
      expect(projectRh.index.getMemory(globalId)).toBeUndefined();
    } finally {
      projectRh.close();
    }
  });
});

describe("MCP extract_session", () => {
	it("extract_session tool runs the extractor and returns the manifest", async () => {
		const extractRepoKey = await mkRepoKey("mcp-extract");
		try {
			await writeSession(extractRepoKey, {
				version: 2,
				id: "s-1",
				startedAt: "2026-04-30T00:00:00Z",
				endedAt: "2026-04-30T01:00:00Z",
				turnCount: 1,
				lastProcessedTurn: 1,
				hasSummary: false,
				hasRaw: true,
				rawDroppedAt: null,
				transcriptPath: "/tmp/x",
				summary: "",
				evidence: {
					toolCalls: [],
					filePaths: [],
					userPrompts: [
						{ turn: 1, text: "actually, always run pnpm typecheck" },
					],
					corrections: [
						{ turn: 1, text: "actually, always run pnpm typecheck" },
					],
				},
				chunks: [],
			});
			const client = await makeClient();
			const result = await client.callTool({
				name: "extract_session",
				arguments: { sessionId: "s-1", repoKey: extractRepoKey },
			});
			expect(result.isError).toBeFalsy();
			const manifest = JSON.parse((result.content[0] as any).text);
			expect(manifest.candidatesCreated).toBe(1);
		} finally {
			await cleanupRepo(extractRepoKey);
		}
	});
});

describe("MCP promote_to_global", () => {
	it("promotes a project memory to global", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "gotcha",
				title: "mcp promote test",
				body: "## Body\ntest",
				scope: { files: [], tags: [] },
				source: "explicit",
				typeFields: { severity: "info" },
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "promote_to_global",
			arguments: { repoKey, id: id! },
		});
		expect(result.isError).toBeFalsy();
		const globalId = (result.content[0] as any).text.trim();
		expect(globalId).toMatch(/^mem-/);

		const { openRetrieve } = await import("../../../src/lib/memory/retrieve.js");
		const globalRh = openRetrieve("global");
		try {
			expect(globalRh.index.getMemory(globalId)?.title).toBe("mcp promote test");
		} finally {
			globalRh.close();
		}
	});
});

describe("MCP memory tool descriptions — opinionated guidance", () => {
	it("recall_memory description marks it browse-only and points to get_memory for use", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const recall = tools.find((t: { name: string }) => t.name === "recall_memory");
		expect(recall?.description).toMatch(/browse/i);
		expect(recall?.description).toMatch(/get_memory/);
	});

	it("get_memory description marks it as the use signal", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const get = tools.find((t: { name: string }) => t.name === "get_memory");
		expect(get?.description).toMatch(/use|apply/i);
		expect(get?.description).toMatch(/cleanup|signal/i);
	});

	it("record_memory description names the trigger conditions", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const rec = tools.find((t: { name: string }) => t.name === "record_memory");
		expect(rec?.description).toMatch(/rule|preference|constraint/i);
	});

	it("deprecate_memory description names when to call", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const dep = tools.find((t: { name: string }) => t.name === "deprecate_memory");
		expect(dep?.description).toMatch(/contradicts|no longer applicable|outdated/i);
	});

	it("confirm_memory description names when to call", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const conf = tools.find((t: { name: string }) => t.name === "confirm_memory");
		expect(conf?.description).toMatch(/endorse|validated|user/i);
	});

	it("promote_to_global description names when to call", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const pro = tools.find((t: { name: string }) => t.name === "promote_to_global");
		expect(pro?.description).toMatch(/cross-project|universal|language pattern/i);
	});
});
