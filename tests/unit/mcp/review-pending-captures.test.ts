import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/mcp/server.js";
import { resolveRepoIdentity } from "../../../src/lib/repo-identity.js";
import { openLifecycle, createMemory } from "../../../src/lib/memory/lifecycle.js";
import { reviewPendingCaptures } from "../../../src/lib/memory/pending-captures.js";
import { mkRepoKey, cleanupRepo } from "../../helpers/memory-fixtures.js";

// This is a thin MCP wrapper; the heavy logic is unit-tested in Task 7.
// Assert the reader is callable and returns the PendingCapture[] contract the
// tool serializes. End-to-end registration is proven by the server-level
// integration test (tests/integration/review-pending-captures-mcp.test.ts).
describe("review_pending_captures contract", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("mcp-cap");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("reader returns the documented shape", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "capture",
				title: "always X",
				body: "always do X because Y",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			const out = await reviewPendingCaptures(repoKey, { limit: 5 });
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({
				title: "always X",
				signalScore: expect.any(Number),
				context: { kind: expect.any(String) },
			});
		} finally {
			lc.close();
		}
	});
});

describe("review_pending_captures over MCP (in-process)", () => {
	let cleanupKey: string;
	let repoKey: string;
	beforeEach(async () => {
		cleanupKey = await mkRepoKey("mcp-cap-tier"); // sets AI_CORTEX_CACHE_HOME to a tmp root
		repoKey = resolveRepoIdentity(process.cwd()).repoKey; // key the server derives from worktreePath
	});
	afterEach(async () => {
		await cleanupRepo(cleanupKey);
	});

	async function callTool(args: Record<string, unknown>): Promise<unknown[]> {
		const server = createServer();
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(st), client.connect(ct)]);
		try {
			const res = await client.callTool({
				name: "review_pending_captures",
				arguments: { worktreePath: process.cwd(), ...args },
			});
			const text = (res.content as { type: string; text: string }[])[0]!.text;
			return JSON.parse(text) as unknown[];
		} finally {
			await client.close();
		}
	}

	it("returns high tier by default and everything with includeLowSignal", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "capture", title: "high",
				body: "always run pnpm build before tagging",
				scope: { files: [], tags: [] }, source: "extracted",
			});
			await createMemory(lc, {
				type: "capture", title: "low",
				body: "push it and prepare a new patch release",
				scope: { files: [], tags: [] }, source: "extracted",
			});
		} finally {
			lc.close();
		}
		const def = (await callTool({})) as { title: string }[];
		expect(def.map((p) => p.title)).toEqual(["high"]);
		const all = (await callTool({ includeLowSignal: true })) as { title: string }[];
		expect(all.map((p) => p.title).sort()).toEqual(["high", "low"]);
	});
});
