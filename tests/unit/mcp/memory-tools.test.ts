import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createServer, resetReconciledKeys } from "../../../src/mcp/server.js";
import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import {
	openLifecycle,
	createMemory,
	trashMemory,
} from "../../../src/lib/memory/lifecycle.js";
import { openRetrieve } from "../../../src/lib/memory/retrieve.js";
import { writeSession } from "../../../src/lib/history/store.js";

let tmp: string;
let repoRoot: string;
let repoKey: string;

function setUpGitRepo(base: string, name = "Repo"): string {
	const root = path.join(base, "work", name);
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "config", "user.email", "t@t"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "i"], { stdio: "ignore" });
	return root;
}

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
	tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-cortex-mcp-mem-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	repoRoot = setUpGitRepo(tmp);
	repoKey = resolveRepoIdentity(repoRoot).repoKey;
	resetReconciledKeys();
});
afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fsp.rm(tmp, { recursive: true, force: true });
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
			arguments: { worktreePath: repoRoot },
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
			arguments: { worktreePath: repoRoot },
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
			arguments: { worktreePath: repoRoot, query: "nonexistent" },
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
			arguments: { worktreePath: repoRoot, id: id! },
		});
		const parsed = JSON.parse((result.content[0] as any).text);
		expect(parsed.frontmatter.id).toBe(id!);
	});

	it("returns isError for nonexistent id", async () => {
		const client = await makeClient();
		const result = await client.callTool({
			name: "get_memory",
			arguments: { worktreePath: repoRoot, id: "nonexistent-id" },
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
			arguments: { worktreePath: repoRoot, id: id! },
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
				worktreePath: repoRoot,
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
			arguments: { worktreePath: repoRoot, id: id!, title: "After", reason: "test" },
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
			arguments: { worktreePath: repoRoot, id: id!, reason: "test" },
		});
		expect(tr.isError).toBeFalsy();

		const ut = await client.callTool({
			name: "untrash_memory",
			arguments: { worktreePath: repoRoot, id: id! },
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
			arguments: { worktreePath: repoRoot },
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
				worktreePath: repoRoot,
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
				worktreePath: repoRoot,
				id,
				title: "E2E test decision (updated)",
				reason: "e2e update",
			},
		});
		expect(updResult.isError).toBeFalsy();

		// 3. Deprecate
		const depResult = await client.callTool({
			name: "deprecate_memory",
			arguments: { worktreePath: repoRoot, id, reason: "e2e deprecate" },
		});
		expect(depResult.isError).toBeFalsy();

		// 4. Restore (back to active)
		const resResult = await client.callTool({
			name: "restore_memory",
			arguments: { worktreePath: repoRoot, id },
		});
		expect(resResult.isError).toBeFalsy();

		// 5. Trash
		const trResult = await client.callTool({
			name: "trash_memory",
			arguments: { worktreePath: repoRoot, id, reason: "e2e trash" },
		});
		expect(trResult.isError).toBeFalsy();

		// 6. Purge
		const prResult = await client.callTool({
			name: "purge_memory",
			arguments: { worktreePath: repoRoot, id, reason: "e2e purge" },
		});
		expect(prResult.isError).toBeFalsy();

		// 7. Audit trail shows all operations
		const auditResult = await client.callTool({
			name: "audit_memory",
			arguments: { worktreePath: repoRoot, id },
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
				worktreePath: repoRoot,
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
			arguments: { worktreePath: repoRoot, query: "Xenova transformer", limit: 5 },
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
        worktreePath: repoRoot,
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
		// Use a fresh separate git fixture for extract so we can seed writeSession with
		// its repoKey independently of the main repoRoot fixture.
		const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicortex-extract-"));
		const origCacheHome = process.env.AI_CORTEX_CACHE_HOME;
		process.env.AI_CORTEX_CACHE_HOME = extractTmp;
		try {
			const extractRepoRoot = setUpGitRepo(extractTmp, "ExtractRepo");
			const extractRepoKey = resolveRepoIdentity(extractRepoRoot).repoKey;
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
			resetReconciledKeys();
			const client = await makeClient();
			const result = await client.callTool({
				name: "extract_session",
				arguments: { sessionId: "s-1", worktreePath: extractRepoRoot },
			});
			expect(result.isError).toBeFalsy();
			const manifest = JSON.parse((result.content[0] as any).text);
			expect(manifest.candidatesCreated).toBe(1);
		} finally {
			process.env.AI_CORTEX_CACHE_HOME = origCacheHome;
			fs.rmSync(extractTmp, { recursive: true, force: true });
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
			arguments: { worktreePath: repoRoot, id: id! },
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

describe("MCP list_memories_pending_rewrite + rewrite_memory", () => {
	it("registers both tools with opinionated descriptions", async () => {
		const client = await makeClient();
		const { tools } = await client.listTools();
		const names = tools.map((t: { name: string }) => t.name);
		expect(names).toContain("list_memories_pending_rewrite");
		expect(names).toContain("rewrite_memory");
		const rewrite = tools.find((t: { name: string }) => t.name === "rewrite_memory");
		expect(rewrite?.description).toMatch(/rule card|rule \+ rationale/i);
		expect(rewrite?.description).toMatch(/promote|active/i);
	});

	it("list_memories_pending_rewrite returns only candidates passing the eligibility predicate", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		const ids: Record<string, string> = {};
		try {
			// (a) candidate, no signals — NOT eligible
			ids.bare = await createMemory(lc, {
				type: "decision",
				title: "bare",
				body: "## Body\nbare",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			// (b) candidate, re-extracted but no pin/get — NOT eligible
			ids.reExtracted = await createMemory(lc, {
				type: "decision",
				title: "re-extracted only",
				body: "## Body\nre",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			lc.index.bumpReExtract(ids.reExtracted);
			// (c) candidate, re-extracted AND pinned — eligible
			ids.eligibleByPin = await createMemory(lc, {
				type: "decision",
				title: "eligible by pin",
				body: "## Body\np",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			lc.index.bumpReExtract(ids.eligibleByPin);
			lc.index.rawDb().prepare("UPDATE memories SET pinned=1 WHERE id=?").run(ids.eligibleByPin);
			// (d) candidate, re-extracted AND get_count > 0 — eligible
			ids.eligibleByGet = await createMemory(lc, {
				type: "decision",
				title: "eligible by get",
				body: "## Body\ng",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			lc.index.bumpReExtract(ids.eligibleByGet);
			lc.index.bumpGetCount(ids.eligibleByGet);
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "list_memories_pending_rewrite",
			arguments: { worktreePath: repoRoot, limit: 10 },
		});
		const items = JSON.parse((result.content[0] as any).text) as Array<{ id: string }>;
		const returnedIds = items.map((i) => i.id).sort();
		expect(returnedIds).toEqual([ids.eligibleByGet, ids.eligibleByPin].sort());
	});

	it("list_memories_pending_rewrite honors the `since` filter", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let oldId: string;
		let newId: string;
		try {
			oldId = await createMemory(lc, {
				type: "decision",
				title: "old",
				body: "## Body\nold",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			newId = await createMemory(lc, {
				type: "decision",
				title: "new",
				body: "## Body\nnew",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			lc.index.bumpReExtract(oldId);
			lc.index.bumpReExtract(newId);
			lc.index.bumpGetCount(oldId);
			lc.index.bumpGetCount(newId);
			// Backdate BOTH timestamps for the old row — `since` now considers
			// updated_at OR last_accessed_at, so we need both stale to truly
			// pre-date the cutoff.
			lc.index.rawDb()
				.prepare(
					"UPDATE memories SET updated_at='2025-01-01T00:00:00Z', last_accessed_at='2025-01-01T00:00:00Z' WHERE id=?",
				)
				.run(oldId);
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "list_memories_pending_rewrite",
			arguments: { worktreePath: repoRoot, since: "2026-01-01T00:00:00Z" },
		});
		const items = JSON.parse((result.content[0] as any).text) as Array<{ id: string }>;
		const ids = items.map((i) => i.id);
		expect(ids).toContain(newId);
		expect(ids).not.toContain(oldId);
	});

	it("list_memories_pending_rewrite includes candidates accessed via get_memory after `since` even if updated_at is older", async () => {
		// A candidate that became eligible via get_memory access (not via
		// re-extract or pin) should not be excluded by `since` just because
		// its updated_at is stale. See `since` filter comment in retrieve.ts.
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let oldId: string;
		try {
			oldId = await createMemory(lc, {
				type: "decision", title: "old but accessed today",
				body: "## Body\nold",
				scope: { files: [], tags: [] }, source: "extracted",
			});
			lc.index.bumpReExtract(oldId);
			lc.index.bumpGetCount(oldId); // sets last_accessed_at = now
			// Backdate updated_at to before the since cutoff.
			lc.index.rawDb()
				.prepare("UPDATE memories SET updated_at='2025-01-01T00:00:00Z' WHERE id=?")
				.run(oldId);
		} finally { lc.close(); }

		const client = await makeClient();
		const result = await client.callTool({
			name: "list_memories_pending_rewrite",
			arguments: { worktreePath: repoRoot, since: "2026-01-01T00:00:00Z" },
		});
		const items = JSON.parse((result.content[0] as any).text) as Array<{ id: string }>;
		const ids = items.map((i) => i.id);
		expect(ids).toContain(oldId); // recent last_accessed_at brings it in
	});

	it("rewrite_memory promotes candidate to active and updates content", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "raw",
				body: "## Body\nraw",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "rewrite_memory",
			arguments: {
				worktreePath: repoRoot,
				id,
				title: "Clean rule",
				body: "## Rule\nclean\n\n## Rationale\nbecause",
				scopeFiles: ["src/x.ts"],
				scopeTags: ["x"],
			},
		});
		expect(result.isError).toBeFalsy();

		const lc2 = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const row = lc2.index.getMemory(id);
			expect(row?.status).toBe("active");
			expect(row?.title).toBe("Clean rule");
			expect(row?.rewritten_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		} finally {
			lc2.close();
		}
	});

	it("rewrite_memory errors on terminal-state memories", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "x",
				body: "## Body\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await trashMemory(lc, id, "test");
		} finally {
			lc.close();
		}

		const client = await makeClient();
		const result = await client.callTool({
			name: "rewrite_memory",
			arguments: {
				worktreePath: repoRoot,
				id,
				title: "y",
				body: "## Rule\ny",
				scopeFiles: [],
				scopeTags: [],
			},
		});
		expect(result.isError).toBe(true);
	});
});
