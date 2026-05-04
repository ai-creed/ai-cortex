import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, resetReconciledKeys } from "../../src/mcp/server.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import Database from "better-sqlite3";

let tmp: string;
let cacheHome: string;
let repoRoot: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
	cacheHome = path.join(tmp, "cache");
	fs.mkdirSync(cacheHome, { recursive: true });
	process.env.AI_CORTEX_CACHE_HOME = cacheHome;
	// Worktree lives elsewhere — must be a separate directory from the cache home,
	// otherwise the literal cache dir and the git checkout collide.
	repoRoot = path.join(tmp, "work", "Favro");
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

describe("smoke: split-brain converges on first MCP call", () => {
	it("seeded literal Favro/ with 1 row, hashed empty → after rehydrate, hashed has 1 row, literal gone", async () => {
		// Simulate the affected machine: literal Favro/ inside the cache home has data;
		// hashed dir absent. The git worktree is a separate directory.
		const literal = path.join(cacheHome, "Favro");
		fs.mkdirSync(path.join(literal, "memory"), { recursive: true });
		const db = new Database(path.join(literal, "memory", "index.sqlite"));
		db.pragma("journal_mode = WAL");
		db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, type TEXT, status TEXT, title TEXT, version INT, created_at TEXT, updated_at TEXT, source TEXT, confidence REAL, pinned INT, body_hash TEXT, body_excerpt TEXT, get_count INT DEFAULT 0, last_accessed_at TEXT, re_extract_count INT DEFAULT 0, rewritten_at TEXT)`);
		db.prepare("INSERT INTO memories(id, type, status, title, version, created_at, updated_at, source, confidence, pinned, body_hash, body_excerpt) VALUES('m1','decision','candidate','t',1,'now','now','manual',0.9,0,'h','b')").run();
		db.close();

		const server = createServer();
		const [s, c] = InMemoryTransport.createLinkedPair();
		await server.connect(s);
		const client = new Client({ name: "t", version: "0.0.1" }, { capabilities: {} });
		await client.connect(c);

		await client.callTool({
			name: "rehydrate_project",
			arguments: { path: repoRoot },
		});

		const { repoKey } = resolveRepoIdentity(repoRoot);
		const hashed = path.join(cacheHome, repoKey);
		expect(fs.existsSync(literal)).toBe(false);
		expect(fs.existsSync(path.join(hashed, "memory", "index.sqlite"))).toBe(true);

		const verify = new Database(path.join(hashed, "memory", "index.sqlite"), { readonly: true });
		const row = verify.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
		verify.close();
		expect(row.c).toBe(1);
	});
});
