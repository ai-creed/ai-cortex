// tests/integration/sqlite-store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { indexRepo } from "../../src/lib/indexer.js";
import {
	writeCache,
	readCacheForWorktree,
	getCacheDbFilePath,
} from "../../src/lib/cache-store.js";
import { queryBlastRadius } from "../../src/lib/blast-radius.js";
import { rankSuggestions } from "../../src/lib/suggest-ranker.js";
import { resolveCacheWithFreshness } from "../../src/lib/cache-coordinator.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";

// Global setup pins AI_CORTEX_CACHE_HOME; override per-test and restore it.
const SESSION_CACHE_HOME = process.env.AI_CORTEX_CACHE_HOME;
let tmpHome: string;
let repo: string;

function git(...args: string[]): void {
	execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeEach(() => {
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-int-home-"));
	process.env.AI_CORTEX_CACHE_HOME = tmpHome;
	// realpath so the fixture path is canonical (macOS /var -> /private/var
	// symlink). resolveRepoIdentity derives repoKey from the unresolved
	// gitCommonDir but worktreeKey from git's symlink-resolved toplevel, so a
	// symlinked path makes a re-resolution (inside indexRepo) produce a different
	// repoKey than the identity we pass to the coordinator.
	repo = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-int-repo-")),
	);

	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "package.json"),
		JSON.stringify({ name: "test-proj", version: "1.0.0" }),
	);
	fs.writeFileSync(
		path.join(repo, "src/b.ts"),
		"export function bar() { return 1; }\n",
	);
	// a.ts exports `foo`, which calls `bar` from b.ts -> a resolvable call edge.
	fs.writeFileSync(
		path.join(repo, "src/a.ts"),
		'import { bar } from "./b.js";\nexport function foo() { return bar(); }\n',
	);
	git("init", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-m", "init");
});

afterEach(() => {
	process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
	fs.rmSync(tmpHome, { recursive: true, force: true });
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("SQLite structural store (integration)", () => {
	it("indexes to a queryable .db and round-trips through readCacheForWorktree", async () => {
		const cache = await indexRepo(repo);
		await writeCache(cache);

		const dbPath = getCacheDbFilePath(cache.repoKey, cache.worktreeKey);
		expect(fs.existsSync(dbPath)).toBe(true);
		const db = new Database(dbPath, { readonly: true });
		try {
			const fnCount = db.prepare("SELECT COUNT(*) c FROM functions").get() as {
				c: number;
			};
			expect(fnCount.c).toBeGreaterThan(0);
		} finally {
			db.close();
		}

		const read = await readCacheForWorktree(cache.repoKey, cache.worktreeKey);
		expect(read).toEqual(cache);
	});

	it("the assembled cache feeds queryBlastRadius identically to the in-memory cache", async () => {
		const cache = await indexRepo(repo);
		await writeCache(cache);
		const read = await readCacheForWorktree(cache.repoKey, cache.worktreeKey);
		expect(read).not.toBeNull();

		const target = cache.functions.find((f) => f.exported)!;
		const fromMemory = queryBlastRadius(
			{ qualifiedName: target.qualifiedName, file: target.file },
			cache.calls,
			cache.functions,
		);
		const fromDb = queryBlastRadius(
			{ qualifiedName: target.qualifiedName, file: target.file },
			read!.calls,
			read!.functions,
		);
		expect(fromDb).toEqual(fromMemory);
	});

	it("the assembled cache feeds rankSuggestions identically to the in-memory cache", async () => {
		const cache = await indexRepo(repo);
		await writeCache(cache);
		const read = await readCacheForWorktree(cache.repoKey, cache.worktreeKey);
		expect(read).not.toBeNull();

		// rankSuggestions is a pure function of (task, RepoCache); identical input
		// caches must produce identical ranked output.
		const task = "foo bar module";
		expect(rankSuggestions(task, read!)).toEqual(rankSuggestions(task, cache));
	});

	it("coordinator fresh/reindexed/stale paths are unchanged with the SQLite store", async () => {
		// indexRepo() persists via writeCache internally, so the first resolve
		// writes the .db; subsequent resolves read it back.
		const identity = resolveRepoIdentity(repo);

		// Cold: no .db/.json yet -> the coordinator indexes -> "reindexed".
		const first = await resolveCacheWithFreshness(identity, {});
		expect(first.cacheStatus).toBe("reindexed");
		expect(
			fs.existsSync(getCacheDbFilePath(identity.repoKey, identity.worktreeKey)),
		).toBe(true);

		// Warm + clean worktree + matching HEAD fingerprint -> "fresh".
		const second = await resolveCacheWithFreshness(identity, {});
		expect(second.cacheStatus).toBe("fresh");

		// Dirty the worktree (modify a committed file) and ask with {stale:true}
		// -> the coordinator returns the cached graph without reindexing -> "stale".
		fs.appendFileSync(path.join(repo, "src/a.ts"), "\n// dirty edit\n");
		const third = await resolveCacheWithFreshness(identity, { stale: true });
		expect(third.cacheStatus).toBe("stale");
	});
});
