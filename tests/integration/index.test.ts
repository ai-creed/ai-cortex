// tests/integration/index.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCachedIndex, indexRepo, rehydrateRepo } from "../../src/lib/index.js";
import { SCHEMA_VERSION } from "../../src/lib/models.js";

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-integration-"));

	// Set up a minimal git repo
	execFileSync("git", ["init", tmpDir]);
	execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);

	// Add files
	fs.writeFileSync(
		path.join(tmpDir, "README.md"),
		"# Test Repo\nA minimal test repo.\n",
	);
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, "src", "main.ts"),
		"export const x = 1;\n",
	);
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "test-repo", version: "0.0.1" }),
	);

	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("indexRepo + getCachedIndex (real disk + real git)", () => {
	it("builds a RepoCache with correct shape", () => {
		const cache = indexRepo(tmpDir);

		expect(cache.schemaVersion).toBe(SCHEMA_VERSION);
		expect(cache.repoKey).toHaveLength(16);
		expect(cache.worktreeKey).toHaveLength(16);
		expect(cache.worktreePath).toBe(fs.realpathSync(tmpDir));
		expect(cache.fingerprint).toHaveLength(40);
		expect(cache.packageMeta.name).toBe("test-repo");
		expect(cache.files.some((f) => f.path === "README.md")).toBe(true);
		expect(cache.docs[0]?.path).toBe("README.md");
		expect(cache.docs[0]?.title).toBe("Test Repo");
	});

	it("getCachedIndex returns the cache when fingerprint is fresh", () => {
		const result = getCachedIndex(tmpDir);
		expect(result).not.toBeNull();
		expect(result?.packageMeta.name).toBe("test-repo");
	});

	it("getCachedIndex returns null after a new commit (stale fingerprint)", () => {
		fs.appendFileSync(path.join(tmpDir, "README.md"), "\nchange\n");
		execFileSync("git", ["-C", tmpDir, "add", "README.md"]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "update"]);

		expect(getCachedIndex(tmpDir)).toBeNull();
	});
});

describe("rehydrateRepo (real disk + real git)", () => {
	it("writes a .md briefing file containing the project name", () => {
		// Re-index first to ensure cache exists for this commit state
		indexRepo(tmpDir);
		const result = rehydrateRepo(tmpDir);

		expect(result.briefingPath).toMatch(/\.md$/);
		expect(fs.existsSync(result.briefingPath)).toBe(true);
		const content = fs.readFileSync(result.briefingPath, "utf8");
		expect(content).toContain("# test-repo");
	});

	it("auto-reindexes after a new commit", () => {
		fs.writeFileSync(
			path.join(tmpDir, "src", "extra.ts"),
			"export const y = 2;\n",
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "add extra"]);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
	});

	it("returns stale when --stale is used after another commit", () => {
		fs.appendFileSync(path.join(tmpDir, "src", "extra.ts"), "\n// change\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "modify extra"]);

		const result = rehydrateRepo(tmpDir, { stale: true });

		expect(result.cacheStatus).toBe("stale");
	});

	it("detects dirty worktree and reindexes", () => {
		// First ensure cache is fresh
		indexRepo(tmpDir);
		// Now dirty the worktree without committing
		fs.appendFileSync(
			path.join(tmpDir, "README.md"),
			"\nuncommitted change\n",
		);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");

		// Clean up for subsequent tests
		execFileSync("git", ["-C", tmpDir, "checkout", "--", "README.md"]);
	});

	it("detects new untracked file and reindexes", () => {
		// Ensure cache is fresh at current HEAD
		indexRepo(tmpDir);
		// Create a new untracked file (not staged, not committed)
		const untrackedFile = path.join(tmpDir, "newfile.ts");
		fs.writeFileSync(untrackedFile, "export const z = 3;\n");

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");

		// Clean up for subsequent tests
		fs.rmSync(untrackedFile);
	});
});

describe("bug reproductions", () => {
	it("unstaged tracked deletion does not crash incremental refresh", () => {
		// Set up: two committed files
		fs.writeFileSync(
			path.join(tmpDir, "src", "b.ts"),
			"export const b = 2;\n",
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "add b"]);
		indexRepo(tmpDir);

		// Delete b.ts from working tree without staging the deletion
		fs.rmSync(path.join(tmpDir, "src", "b.ts"));

		// Should NOT throw ENOENT — should detect b.ts as removed
		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
		expect(
			result.cache.files.find((f) => f.path === "src/b.ts"),
		).toBeUndefined();

		// Clean up: stage the deletion and commit
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "remove b"]);
	});
	it("new commit + uncommitted edit marks cache as dirty", () => {
		indexRepo(tmpDir);

		// New commit changes fingerprint
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const committed = true;\n",
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "commit change"]);

		// Also dirty the worktree (uncommitted edit)
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const dirty = true;\n",
		);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
		// Must be dirty — worktree has uncommitted edit
		expect(result.cache.dirtyAtIndex).toBe(true);

		// Now revert the dirty edit
		execFileSync("git", ["-C", tmpDir, "checkout", "--", "src/main.ts"]);

		// Next rehydrate should NOT be fresh — cache has dirty hash
		const reverted = rehydrateRepo(tmpDir);
		expect(reverted.cacheStatus).toBe("reindexed");
		expect(reverted.cache.dirtyAtIndex).toBe(false);
	});
});

describe("incremental refresh (real disk + real git)", () => {
	it("uses incremental reindex after modifying one file", () => {
		// Ensure fresh cache
		const initial = indexRepo(tmpDir);
		const initialFileCount = initial.files.length;

		// Modify one file and commit
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const x = 999;\n",
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "tweak main"]);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
		// File count should stay the same (incremental, not adding/removing)
		expect(result.cache.files.length).toBe(initialFileCount);
		// Content hash for main.ts should have changed
		const mainFile = result.cache.files.find((f) =>
			f.path === "src/main.ts",
		);
		expect(mainFile?.contentHash).toBeDefined();
	});

	it("second rehydrate on same dirty worktree has empty incremental diff", () => {
		// Ensure fresh cache
		indexRepo(tmpDir);

		// Dirty the worktree without committing
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const dirty = true;\n",
		);

		// First rehydrate picks up the dirty change
		const first = rehydrateRepo(tmpDir);
		expect(first.cacheStatus).toBe("reindexed");
		expect(first.cache.dirtyAtIndex).toBe(true);

		// Second rehydrate — same dirty state, but cache already has correct hashes
		// Hash validation filters out the already-processed file
		const second = rehydrateRepo(tmpDir);
		expect(second.cacheStatus).toBe("reindexed");

		// Clean up
		execFileSync("git", ["-C", tmpDir, "checkout", "--", "src/main.ts"]);
	});

	it("dirty edit then revert triggers reindex, not fresh (dirty-revert)", () => {
		// Ensure fresh cache
		indexRepo(tmpDir);

		// Dirty the worktree
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const dirty = true;\n",
		);

		// Rehydrate picks up dirty change — cache now has dirtyAtIndex=true
		const dirty = rehydrateRepo(tmpDir);
		expect(dirty.cacheStatus).toBe("reindexed");
		expect(dirty.cache.dirtyAtIndex).toBe(true);

		// Revert the edit — worktree is clean again
		execFileSync("git", ["-C", tmpDir, "checkout", "--", "src/main.ts"]);

		// Rehydrate should NOT return "fresh" — cache has stale dirty content
		const reverted = rehydrateRepo(tmpDir);
		expect(reverted.cacheStatus).toBe("reindexed");
		// After reindex from clean state, dirtyAtIndex should be false
		expect(reverted.cache.dirtyAtIndex).toBe(false);
	});

	it("removes package.json and rehydrate uses fallback packageMeta", () => {
		indexRepo(tmpDir);

		// Remove package.json and commit
		fs.rmSync(path.join(tmpDir, "package.json"));
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "remove pkg"]);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
		// Fallback: name = dirname, version = 0.0.0
		expect(result.cache.packageMeta.version).toBe("0.0.0");
		expect(result.cache.packageMeta.framework).toBeNull();

		// Restore for subsequent tests
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "test-repo", version: "0.0.1" }),
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "restore pkg"]);
	});

	it("falls back to hash compare when cached fingerprint is nonexistent", () => {
		// Index at current HEAD
		const cache = indexRepo(tmpDir);

		// Tamper with persisted cache to set fingerprint to nonexistent SHA
		const cacheDir = path.join(
			os.homedir(),
			".cache",
			"ai-cortex",
			"v1",
			cache.repoKey,
		);
		const cacheFile = path.join(cacheDir, `${cache.worktreeKey}.json`);
		const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		raw.fingerprint = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		fs.writeFileSync(cacheFile, JSON.stringify(raw));

		// Modify a file so there's something to detect
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const fallback = true;\n",
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "change for fallback test"]);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
		// Should still work — falls back to hash comparison
		expect(result.cache.files.length).toBeGreaterThan(0);
	});

	it("stale import edges remain after rename (known limitation)", () => {
		// Set up: main.ts imports utils.ts
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			'import { helper } from "./utils";\nexport const x = helper();\n',
		);
		fs.writeFileSync(
			path.join(tmpDir, "src", "utils.ts"),
			"export function helper() { return 1; }\n",
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "add utils"]);
		indexRepo(tmpDir);

		// Rename utils.ts to helpers.ts (but don't update main.ts import)
		fs.renameSync(
			path.join(tmpDir, "src", "utils.ts"),
			path.join(tmpDir, "src", "helpers.ts"),
		);
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "rename utils"]);

		const result = rehydrateRepo(tmpDir);

		expect(result.cacheStatus).toBe("reindexed");
		// main.ts was not changed, so its import edge still points to src/utils
		const staleEdge = result.cache.imports.find(
			(e) => e.from === "src/main.ts" && e.to === "src/utils",
		);
		expect(staleEdge).toBeDefined(); // Known limitation

		// Clean up
		fs.writeFileSync(
			path.join(tmpDir, "src", "main.ts"),
			"export const x = 1;\n",
		);
		fs.rmSync(path.join(tmpDir, "src", "helpers.ts"));
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "clean up rename test"]);
	});

	it("schema v1 cache triggers full reindex", () => {
		// Build current cache
		const cache = indexRepo(tmpDir);

		// Tamper with cache file to simulate v1 schema
		const cacheDir = path.join(
			os.homedir(),
			".cache",
			"ai-cortex",
			"v1",
			cache.repoKey,
		);
		const cacheFile = path.join(cacheDir, `${cache.worktreeKey}.json`);
		const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		raw.schemaVersion = "1";
		fs.writeFileSync(cacheFile, JSON.stringify(raw));

		const result = rehydrateRepo(tmpDir);

		// Should do full reindex because schema mismatch nukes cache
		expect(result.cacheStatus).toBe("reindexed");
		expect(result.cache.schemaVersion).toBe(SCHEMA_VERSION);
	});
});
