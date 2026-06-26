import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { runSurfaceHook } from "../../src/lib/memory/cli/surface-hook.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import { createServer, resetReconciledKeys, _resetSessionIdMemoForTest } from "../../src/mcp/server.js";
import { readGetEvents, readSurfaceEvents } from "../../src/lib/stats/surface-events.js";

let tmp: string;
let repoRoot: string;
let repoKey: string;

function setUpGitRepo(base: string): string {
	const root = path.join(base, "work", "Repo");
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "config", "user.email", "t@t"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "i"], { stdio: "ignore" });
	return root;
}

async function makeClient(): Promise<any> {
	const server = createServer();
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
	await client.connect(clientTransport);
	return client;
}

beforeEach(async () => {
	tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-cortex-b1-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	// Resolve symlinks so that git's --show-toplevel output and os.tmpdir() paths agree
	// (on macOS, os.tmpdir() returns /var/... but git rev-parse --show-toplevel returns
	// /private/var/... — causing path.relative to produce ../../ prefixes in toRepoRel).
	repoRoot = fs.realpathSync(setUpGitRepo(tmp));
	repoKey = resolveRepoIdentity(repoRoot).repoKey;
	resetReconciledKeys();
});
afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fsp.rm(tmp, { recursive: true, force: true });
});

describe("get-event session attribution (B1)", () => {
	it("the get_memory handler logs a get-event with the same canonical session id as the surface event", async () => {
		const prev = process.env.AI_CORTEX_SESSION_ID;
		process.env.AI_CORTEX_SESSION_ID = "sess-b1";
		_resetSessionIdMemoForTest();
		try {
			const rel = "src/x.ts";
			let memId = "";
			const lc = await openLifecycle(repoKey, { agentId: "t" });
			try {
				memId = await createMemory(lc, {
					type: "decision", title: "b1 rule", body: "## r\nx",
					scope: { files: [rel], tags: [] }, source: "explicit",
				});
			} finally { lc.close(); }

			// 1) Surface via the hook (session id comes from hook stdin).
			await runSurfaceHook({
				stdin: Readable.from([JSON.stringify({
					session_id: "sess-b1", cwd: repoRoot,
					tool_name: "Edit", tool_input: { file_path: `${repoRoot}/${rel}` },
				})]),
				stdout: { write: () => true } as unknown as NodeJS.WriteStream,
			});

			// 2) Consult via the REAL get_memory MCP handler (createServer + callTool).
			const client = await makeClient();
			const res = await client.callTool({
				name: "get_memory",
				arguments: { worktreePath: repoRoot, id: memId },
			});
			expect((res.content[0] as any).text).toContain("b1 rule");

			// 3) Both telemetry logs must carry the same canonical session id.
			const surfaceSid = readSurfaceEvents(repoKey)[0]!.session_id;
			const getEvents = readGetEvents(repoKey);
			expect(getEvents.length).toBe(1);
			expect(getEvents[0]!.memoryId).toBe(memId);
			expect(getEvents[0]!.session_id).toBe("sess-b1");
			expect(getEvents[0]!.session_id).toBe(surfaceSid);
		} finally {
			if (prev === undefined) delete process.env.AI_CORTEX_SESSION_ID;
			else process.env.AI_CORTEX_SESSION_ID = prev;
			_resetSessionIdMemoForTest();
		}
	});
});
