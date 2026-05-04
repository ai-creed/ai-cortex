import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, resetReconciledKeys } from "../../src/mcp/server.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";

let tmp: string;
let cacheHome: string;
let repoRoot: string;

async function makeClient(): Promise<Client> {
	const server = createServer();
	const [s, c] = InMemoryTransport.createLinkedPair();
	await server.connect(s);
	const client = new Client({ name: "t", version: "0.0.1" }, { capabilities: {} });
	await client.connect(c);
	return client;
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwp-"));
	cacheHome = path.join(tmp, "cache");
	fs.mkdirSync(cacheHome, { recursive: true });
	process.env.AI_CORTEX_CACHE_HOME = cacheHome;
	repoRoot = path.join(tmp, "work", "Repo");
	fs.mkdirSync(repoRoot, { recursive: true });
	execFileSync("git", ["-C", repoRoot, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@t"], { stdio: "ignore" });
	execFileSync("git", ["-C", repoRoot, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", repoRoot, "commit", "--allow-empty", "-m", "i"], { stdio: "ignore" });
	resetReconciledKeys();
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedMemory(
	client: Client,
	worktreePath: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const res = (await client.callTool({
		name: "record_memory",
		arguments: {
			worktreePath,
			type: "decision",
			title: "seed",
			body: "seed body content with enough characters to pass any floor",
			...overrides,
		},
	})) as { content: Array<{ type: string; text: string }> };
	return res.content[0].text.trim();
}

type ToolArgsBuilder = (
	wp: string,
	client: Client,
) => Promise<Record<string, unknown>>;

const TOOL_ARGS: Record<string, ToolArgsBuilder> = {
	recall_memory: async (wp) => ({ worktreePath: wp, query: "seed" }),
	list_memories: async (wp) => ({ worktreePath: wp }),
	search_memories: async (wp) => ({ worktreePath: wp, query: "seed" }),
	rebuild_index: async (wp) => ({ worktreePath: wp }),
	sweep_aging: async (wp) => ({ worktreePath: wp }),
	list_memories_pending_rewrite: async (wp) => ({ worktreePath: wp }),
	record_memory: async (wp) => ({
		worktreePath: wp,
		type: "decision",
		title: "rec",
		body: "record body content with enough characters to pass any floor",
	}),
	get_memory: async (wp, c) => ({ worktreePath: wp, id: await seedMemory(c, wp) }),
	audit_memory: async (wp, c) => ({ worktreePath: wp, id: await seedMemory(c, wp) }),
	update_memory: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
		title: "updated title",
		reason: "test update",
	}),
	update_scope: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
		scopeFiles: ["src/x.ts"],
		scopeTags: ["tag1"],
	}),
	deprecate_memory: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
		reason: "no longer applies",
	}),
	trash_memory: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
		reason: "test trash",
	}),
	pin_memory: async (wp, c) => ({ worktreePath: wp, id: await seedMemory(c, wp) }),
	unpin_memory: async (wp, c) => ({ worktreePath: wp, id: await seedMemory(c, wp) }),
	confirm_memory: async (wp, c) => ({ worktreePath: wp, id: await seedMemory(c, wp) }),
	rewrite_memory: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
		title: "rewritten",
		body: "rewritten body content with enough characters to pass any floor",
		scopeFiles: [],
		scopeTags: [],
	}),
	promote_to_global: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
	}),
	add_evidence: async (wp, c) => ({
		worktreePath: wp,
		id: await seedMemory(c, wp),
		sessionId: "sess-1",
		turn: 1,
		kind: "user_correction",
	}),
	merge_memories: async (wp, c) => ({
		worktreePath: wp,
		srcId: await seedMemory(c, wp, { title: "src" }),
		dstId: await seedMemory(c, wp, { title: "dst" }),
		mergedBody: "merged body content with enough characters to pass any floor",
	}),
	link_memories: async (wp, c) => ({
		worktreePath: wp,
		srcId: await seedMemory(c, wp, { title: "src" }),
		dstId: await seedMemory(c, wp, { title: "dst" }),
		relType: "supports",
	}),
	unlink_memories: async (wp, c) => {
		const srcId = await seedMemory(c, wp, { title: "src" });
		const dstId = await seedMemory(c, wp, { title: "dst" });
		await c.callTool({
			name: "link_memories",
			arguments: { worktreePath: wp, srcId, dstId, relType: "supports" },
		});
		return { worktreePath: wp, srcId, dstId, relType: "supports" };
	},
	restore_memory: async (wp, c) => {
		const id = await seedMemory(c, wp);
		await c.callTool({
			name: "deprecate_memory",
			arguments: { worktreePath: wp, id, reason: "test" },
		});
		return { worktreePath: wp, id };
	},
	untrash_memory: async (wp, c) => {
		const id = await seedMemory(c, wp);
		await c.callTool({
			name: "trash_memory",
			arguments: { worktreePath: wp, id, reason: "test" },
		});
		return { worktreePath: wp, id };
	},
	purge_memory: async (wp, c) => {
		const id = await seedMemory(c, wp);
		await c.callTool({
			name: "trash_memory",
			arguments: { worktreePath: wp, id, reason: "test" },
		});
		return { worktreePath: wp, id, reason: "test purge" };
	},
	extract_session: async (wp) => ({
		worktreePath: wp,
		sessionId: "session-not-captured",
	}),
};

const TOOL_NAMES = Object.keys(TOOL_ARGS);
const TOLERATE_HANDLER_THROW = new Set(["extract_session"]);

describe.each(TOOL_NAMES)("%s contract", (toolName) => {
	it(`requires worktreePath — replacing it with repoKey errors with Zod 'Required'`, async () => {
		const client = await makeClient();
		const valid = await TOOL_ARGS[toolName](repoRoot, client);
		const { worktreePath: _wp, ...rest } = valid;
		const legacyArgs = { ...rest, repoKey: "Repo" };

		// The MCP SDK may either reject the promise OR return isError:true with the
		// validation error embedded in content[0].text — handle both.
		let result: { isError?: boolean; content?: Array<{ text?: string }> } = {};
		try {
			result = (await client.callTool({ name: toolName, arguments: legacyArgs })) as typeof result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toMatch(/worktreePath|Required/i);
			return;
		}
		expect(result.isError).toBe(true);
		const text = result.content?.[0]?.text ?? "";
		expect(text).toMatch(/worktreePath|Required/i);
	});

	it(`writes/reads under <sha16>/, never a literal-name dir`, async () => {
		const client = await makeClient();
		const { repoKey } = resolveRepoIdentity(repoRoot);
		const args = await TOOL_ARGS[toolName](repoRoot, client);

		let threw: unknown;
		try {
			await client.callTool({ name: toolName, arguments: args });
		} catch (err) {
			threw = err;
		}

		if (threw && !TOLERATE_HANDLER_THROW.has(toolName)) {
			throw threw;
		}

		expect(fs.existsSync(path.join(cacheHome, repoKey))).toBe(true);
		expect(fs.existsSync(path.join(cacheHome, "Repo"))).toBe(false);
		expect(fs.existsSync(path.join(cacheHome, path.basename(repoRoot)))).toBe(false);
	});
});
