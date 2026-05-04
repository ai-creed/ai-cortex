import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runRepoKeyMigrationIfNeeded,
	SENTINEL_NAME,
	discoverLiteralCandidates,
	classifyStore,
	deleteEmptyStore,
	checkpointAndVerify,
} from "../../../src/lib/cache-store-migrate.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runRepoKeyMigrationIfNeeded — sentinel fast-path", () => {
	it("returns already-migrated and writes no work when sentinel exists", async () => {
		const repoKey = "0123456789abcdef";
		const dir = path.join(tmp, repoKey);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, SENTINEL_NAME),
			JSON.stringify({ migratedAt: "2026-05-04T00:00:00Z", outcomes: [] }),
		);

		const result = await runRepoKeyMigrationIfNeeded(repoKey, "/tmp");

		expect(result.outcome).toBe("already-migrated");
		expect(result.details).toEqual([]);
	});
});

function gitInit(dir: string, branch = "main") {
	execFileSync("git", ["-C", dir, "init", "-b", branch], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
}

describe("discoverLiteralCandidates", () => {
	it("includes worktree basename, repo-root basename, and branch name", () => {
		const repoRoot = path.join(tmp, "MyRepo");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot, "feature-x");

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates).toContain("MyRepo");
		expect(candidates).toContain("feature-x");
	});

	it("dedups when worktree basename equals branch name", () => {
		const repoRoot = path.join(tmp, "Repo");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot, "Repo");

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates.filter((c) => c === "Repo")).toHaveLength(1);
	});

	it("excludes the reserved 'global' literal", () => {
		const repoRoot = path.join(tmp, "global");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot);

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates).not.toContain("global");
	});

	it("excludes 16-hex-shaped names", () => {
		const repoRoot = path.join(tmp, "0123456789abcdef");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot);

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates).not.toContain("0123456789abcdef");
	});

	it("swallows detached-HEAD (no branch) without throwing", () => {
		const repoRoot = path.join(tmp, "detached");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot);
		execFileSync("git", ["-C", repoRoot, "checkout", "--detach", "HEAD"], {
			stdio: "ignore",
		});

		expect(() => discoverLiteralCandidates(repoRoot)).not.toThrow();
		const candidates = discoverLiteralCandidates(repoRoot);
		expect(candidates).toContain("detached");
	});
});

function makeStore(dir: string): void {
	fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
	fs.mkdirSync(path.join(dir, "history", "sessions"), { recursive: true });
	fs.mkdirSync(path.join(dir, "extractor-runs"), { recursive: true });
}

function makeDbWithRow(dir: string): void {
	makeStore(dir);
	const db = new Database(path.join(dir, "memory", "index.sqlite"));
	db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY)`);
	db.prepare("INSERT INTO memories(id) VALUES (?)").run("m1");
	db.close();
}

describe("classifyStore", () => {
	it("returns 'empty' for a directory that does not exist", () => {
		expect(classifyStore(path.join(tmp, "nonexistent"))).toBe("empty");
	});

	it("returns 'empty' for an existing dir with only schema (zero rows)", () => {
		const dir = path.join(tmp, "empty-schema");
		makeStore(dir);
		const db = new Database(path.join(dir, "memory", "index.sqlite"));
		db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY)`);
		db.close();
		expect(classifyStore(dir)).toBe("empty");
	});

	it("returns 'populated' when memories table has rows", () => {
		const dir = path.join(tmp, "populated-rows");
		makeDbWithRow(dir);
		expect(classifyStore(dir)).toBe("populated");
	});

	it("returns 'populated' when history sessions exist", () => {
		const dir = path.join(tmp, "populated-history");
		makeStore(dir);
		fs.mkdirSync(path.join(dir, "history", "sessions", "uuid-1"));
		fs.writeFileSync(
			path.join(dir, "history", "sessions", "uuid-1", "session.json"),
			"{}",
		);
		expect(classifyStore(dir)).toBe("populated");
	});

	it("returns 'populated' when extractor-runs has files", () => {
		const dir = path.join(tmp, "populated-extractor");
		makeStore(dir);
		fs.writeFileSync(path.join(dir, "extractor-runs", "uuid.json"), "{}");
		expect(classifyStore(dir)).toBe("populated");
	});
});

describe("deleteEmptyStore", () => {
	it("removes the directory when classification is empty", () => {
		const dir = path.join(tmp, "to-delete");
		makeStore(dir);
		deleteEmptyStore(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("throws if classification is populated", () => {
		const dir = path.join(tmp, "do-not-delete");
		makeDbWithRow(dir);
		expect(() => deleteEmptyStore(dir)).toThrow(/not empty/i);
		expect(fs.existsSync(dir)).toBe(true);
	});
});

describe("checkpointAndVerify", () => {
	it("folds WAL frames and removes -wal/-shm sidecars on success", () => {
		const dir = path.join(tmp, "wal-clean");
		fs.mkdirSync(dir, { recursive: true });
		const dbPath = path.join(dir, "i.sqlite");
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		db.exec("CREATE TABLE t(x)");
		db.prepare("INSERT INTO t(x) VALUES(?)").run(1);
		db.close();

		expect(() => checkpointAndVerify(dbPath)).not.toThrow();
		expect(fs.existsSync(dbPath + "-wal")).toBe(false);
		expect(fs.existsSync(dbPath + "-shm")).toBe(false);
	});

	it("throws when -wal frames remain after checkpoint (held by another reader)", () => {
		const dir = path.join(tmp, "wal-held");
		fs.mkdirSync(dir, { recursive: true });
		const dbPath = path.join(dir, "i.sqlite");
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		db.exec("CREATE TABLE t(x)");
		db.prepare("INSERT INTO t(x) VALUES(?)").run(1);

		// Hold an open read transaction via an iterator to prevent checkpoint completion.
		const reader = new Database(dbPath, { readonly: true });
		const iter = reader.prepare("SELECT * FROM t").iterate();
		iter.next(); // advance to open the implicit read transaction

		try {
			expect(() => checkpointAndVerify(dbPath)).toThrow(
				/checkpoint incomplete|frames remaining/i,
			);
		} finally {
			iter.return?.();
			reader.close();
			db.close();
		}
	});
});
