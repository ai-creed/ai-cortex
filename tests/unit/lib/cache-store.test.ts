// tests/unit/lib/cache-store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";

// Mock child_process so promisify(exec) resolves controlled values.
// vi.mock hoists this before imports.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		exec: vi.fn(),
	};
});

import { exec } from "node:child_process";
import {
	assertHashedRepoKey,
	buildRepoFingerprint,
	ensureValidDb,
	getCacheDbFilePath,
	getCacheDir,
	getCacheMetaFilePath,
	isWorktreeDirty,
	readCacheForWorktree,
	RepoKeyError,
	writeCache,
} from "../../../src/lib/cache-store.js";

const mockExec = vi.mocked(exec);

function mockExecSuccess(stdout: string): void {
	// promisify(exec) calls exec(cmd, callback) or exec(cmd, opts, callback)
	mockExec.mockImplementation((...args: any[]) => {
		const cb = args[args.length - 1];
		cb(null, { stdout, stderr: "" });
		return {} as any;
	});
}

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-04-10T00:00:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test", version: "1.0.0", framework: null },
		entryFiles: [],
		files: [],
		docs: [],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

let tmpDir: string;

// The global setup (tests/helpers/isolate-cache-home.ts) pins
// AI_CORTEX_CACHE_HOME to a session tmpdir, which takes precedence over
// os.homedir(). Tests that need their OWN isolated cache home override the env
// per-test and restore this session value afterward (deleting it would strip
// isolation for later files sharing the worker).
const SESSION_CACHE_HOME = process.env.AI_CORTEX_CACHE_HOME;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cache-test-"));
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeCache + readCacheForWorktree", () => {
	it("writes and reads back a cache", async () => {
		const cache = makeCache();
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

		await writeCache(cache);
		const result = await readCacheForWorktree(cache.repoKey, cache.worktreeKey);

		expect(result).not.toBeNull();
		expect(result?.fingerprint).toBe("abc123");
		expect(result?.packageMeta.name).toBe("test");
	});

	it("returns null when no cache file exists", async () => {
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		expect(await readCacheForWorktree("0000000000000000", "eeff00112233aabb")).toBeNull();
	});

	it("returns null and warns to stderr on schema version mismatch", async () => {
		const cache = makeCache({ schemaVersion: "0" as any });
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		await writeCache(cache);
		const result = await readCacheForWorktree(cache.repoKey, cache.worktreeKey);

		expect(result).toBeNull();
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("cache schema updated"),
		);
	});
});

describe("writeCache sidecar (*.meta.json)", () => {
	it("emits a sidecar with the 4 derived fields", async () => {
		const cache = makeCache({
			indexedAt: "2026-05-19T08:17:21.370Z",
			fingerprint: "deadbeef0000",
			packageMeta: { name: "ai-cortex", version: "1.0.0", framework: null },
			files: [
				{ path: "a.ts", kind: "file", contentHash: "h1" } as any,
				{ path: "b.ts", kind: "file", contentHash: "h2" } as any,
				{ path: "c.ts", kind: "file", contentHash: "h3" } as any,
			],
		});
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

		await writeCache(cache);

		const sidecarPath = getCacheMetaFilePath(cache.repoKey, cache.worktreeKey);
		const raw = fs.readFileSync(sidecarPath, "utf8");
		expect(JSON.parse(raw)).toEqual({
			indexedAt: "2026-05-19T08:17:21.370Z",
			fingerprint: "deadbeef0000",
			fileCount: 3,
			name: "ai-cortex",
			// Spec §confirm dialog: dashboard surfaces this in the clean confirm.
			worktreePath: "/repo",
		});
	});

	it("sidecar write failure does not throw or block main JSON", async () => {
		const cache = makeCache();
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		const realWriteFile = fs.promises.writeFile;
		const writeSpy = vi
			.spyOn(fs.promises, "writeFile")
			.mockImplementation(async (p: any, data: any, opts?: any) => {
				if (typeof p === "string" && p.includes(".meta.json")) {
					throw new Error("simulated sidecar write failure");
				}
				return realWriteFile(p, data, opts);
			});
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		await expect(writeCache(cache)).resolves.toBeUndefined();

		// main JSON is still readable
		const result = await readCacheForWorktree(cache.repoKey, cache.worktreeKey);
		expect(result).not.toBeNull();
		expect(result?.fingerprint).toBe("abc123");

		writeSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("emits sidecar with null name when packageMeta.name is missing", async () => {
		const cache = makeCache({
			packageMeta: { name: null as any, version: "0.0.0", framework: null },
		});
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

		await writeCache(cache);

		const sidecarPath = getCacheMetaFilePath(cache.repoKey, cache.worktreeKey);
		const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
		expect(parsed.name).toBeNull();
	});
});

describe("writeCache (SQLite)", () => {
	beforeEach(() => {
		process.env.AI_CORTEX_CACHE_HOME = tmpDir;
	});
	afterEach(() => {
		process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
	});

	it("writes a .db (not a .json) plus the .meta.json sidecar", async () => {
		const cache = makeCache({
			files: [{ path: "src/a.ts", kind: "file", contentHash: "h1" }],
			functions: [
				{
					qualifiedName: "foo",
					file: "src/a.ts",
					exported: true,
					isDefaultExport: false,
					line: 1,
				},
			],
		});
		await writeCache(cache);

		const dbPath = getCacheDbFilePath(cache.repoKey, cache.worktreeKey);
		expect(fs.existsSync(dbPath)).toBe(true);
		expect(
			fs.existsSync(getCacheMetaFilePath(cache.repoKey, cache.worktreeKey)),
		).toBe(true);
		expect(fs.existsSync(dbPath + "-wal")).toBe(false);

		const db = new Database(dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT COUNT(*) c FROM functions").get()).toEqual({
				c: 1,
			});
		} finally {
			db.close();
		}
	});

	it("deletes a leftover legacy .json when writing", async () => {
		const cache = makeCache();
		fs.mkdirSync(getCacheDir(cache.repoKey), { recursive: true });
		const jsonPath = path.join(
			getCacheDir(cache.repoKey),
			cache.worktreeKey + ".json",
		);
		fs.writeFileSync(jsonPath, "{}");
		await writeCache(cache);
		expect(fs.existsSync(jsonPath)).toBe(false);
	});
});

describe("readCacheForWorktree (SQLite + migration)", () => {
	const repoKey = "aabbccdd11223344";
	const worktreeKey = "eeff00112233aabb";

	beforeEach(() => {
		process.env.AI_CORTEX_CACHE_HOME = tmpDir;
	});
	afterEach(() => {
		process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
	});

	function writeLegacyJson(cache: RepoCache): string {
		const dir = getCacheDir(repoKey);
		fs.mkdirSync(dir, { recursive: true });
		const p = path.join(dir, `${worktreeKey}.json`);
		fs.writeFileSync(p, JSON.stringify(cache, null, 2));
		return p;
	}

	it("round-trips through write then read (db path)", async () => {
		const cache = makeCache({
			files: [{ path: "src/a.ts", kind: "file", contentHash: "h1" }],
			functions: [
				{
					qualifiedName: "foo",
					file: "src/a.ts",
					exported: true,
					isDefaultExport: false,
					line: 1,
				},
			],
			calls: [{ from: "src/a.ts::foo", to: "src/b.ts::bar", kind: "call" }],
		});
		await writeCache(cache);
		expect(await readCacheForWorktree(repoKey, worktreeKey)).toEqual(cache);
	});

	it("returns null when neither db nor json exists", async () => {
		expect(await readCacheForWorktree(repoKey, worktreeKey)).toBeNull();
	});

	it("transcodes a compatible legacy .json: db created, json deleted, sidecar written", async () => {
		const cache = makeCache({
			files: [{ path: "x.ts", kind: "file", contentHash: "h" }],
		});
		const jsonPath = writeLegacyJson(cache);

		const result = await readCacheForWorktree(repoKey, worktreeKey);

		expect(result).toEqual(cache);
		expect(fs.existsSync(jsonPath)).toBe(false);
		expect(fs.existsSync(getCacheDbFilePath(repoKey, worktreeKey))).toBe(true);
		expect(fs.existsSync(getCacheMetaFilePath(repoKey, worktreeKey))).toBe(true);
	});

	it("does NOT reindex (preserves the cache) for a compatible legacy json", async () => {
		const cache = makeCache({ fingerprint: "preserve-me" });
		writeLegacyJson(cache);
		const result = await readCacheForWorktree(repoKey, worktreeKey);
		expect(result?.fingerprint).toBe("preserve-me");
	});

	it("reindexes (returns null) for an incompatible-major legacy json and deletes it", async () => {
		const cache = makeCache({
			schemaVersion: "2" as RepoCache["schemaVersion"],
		});
		const jsonPath = writeLegacyJson(cache);
		expect(await readCacheForWorktree(repoKey, worktreeKey)).toBeNull();
		expect(fs.existsSync(jsonPath)).toBe(false);
	});

	it("reindexes (returns null) for a corrupt legacy json and deletes it", async () => {
		const dir = getCacheDir(repoKey);
		fs.mkdirSync(dir, { recursive: true });
		const jsonPath = path.join(dir, `${worktreeKey}.json`);
		fs.writeFileSync(jsonPath, "{ not valid json");
		expect(await readCacheForWorktree(repoKey, worktreeKey)).toBeNull();
		expect(fs.existsSync(jsonPath)).toBe(false);
	});

	it("deletes a leftover json when a valid db already exists", async () => {
		const cache = makeCache();
		await writeCache(cache);
		const jsonPath = path.join(getCacheDir(repoKey), `${worktreeKey}.json`);
		fs.writeFileSync(jsonPath, "{}");
		await readCacheForWorktree(repoKey, worktreeKey);
		expect(fs.existsSync(jsonPath)).toBe(false);
	});

	it("returns null and clears a store-format-mismatched db", async () => {
		const cache = makeCache();
		await writeCache(cache);
		const dbPath = getCacheDbFilePath(repoKey, worktreeKey);
		const db = new Database(dbPath);
		db.pragma("user_version = 999");
		db.close();
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		expect(await readCacheForWorktree(repoKey, worktreeKey)).toBeNull();
		expect(fs.existsSync(dbPath)).toBe(false);
		stderrSpy.mockRestore();
	});
});

describe("ensureValidDb", () => {
	const repoKey = "aabbccdd11223344";
	const worktreeKey = "eeff00112233aabb";
	beforeEach(() => {
		process.env.AI_CORTEX_CACHE_HOME = tmpDir;
	});
	afterEach(() => {
		process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
	});

	it("returns the db path for a valid db", async () => {
		await writeCache(makeCache());
		const p = await ensureValidDb(repoKey, worktreeKey);
		expect(p).toBe(getCacheDbFilePath(repoKey, worktreeKey));
	});

	it("returns null when nothing exists", async () => {
		expect(await ensureValidDb(repoKey, worktreeKey)).toBeNull();
	});

	it("returns null and clears a store-format-mismatched db", async () => {
		await writeCache(makeCache());
		const dbPath = getCacheDbFilePath(repoKey, worktreeKey);
		const db = new Database(dbPath);
		db.pragma("user_version = 999");
		db.close();
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		expect(await ensureValidDb(repoKey, worktreeKey)).toBeNull();
		expect(fs.existsSync(dbPath)).toBe(false);
		stderrSpy.mockRestore();
	});

	it("migrates a compatible legacy json and returns the db path", async () => {
		const dir = getCacheDir(repoKey);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${worktreeKey}.json`),
			JSON.stringify(makeCache(), null, 2),
		);
		const p = await ensureValidDb(repoKey, worktreeKey);
		expect(p).toBe(getCacheDbFilePath(repoKey, worktreeKey));
		expect(fs.existsSync(path.join(dir, `${worktreeKey}.json`))).toBe(false);
	});
});

describe("buildRepoFingerprint", () => {
	it("returns trimmed HEAD commit hash from git", async () => {
		mockExecSuccess("abc123def456\n");
		expect(await buildRepoFingerprint("/repo")).toBe("abc123def456");
	});
});

describe("isWorktreeDirty", () => {
	it("returns false when git status output is empty", async () => {
		mockExecSuccess("");
		expect(await isWorktreeDirty("/repo")).toBe(false);
	});

	it("returns true when git status output contains tracked or untracked changes", async () => {
		mockExecSuccess(" M src/main.ts\n?? newfile.ts\n");
		expect(await isWorktreeDirty("/repo")).toBe(true);
	});
});

describe("assertHashedRepoKey", () => {
	it.each([
		"0123456789abcdef",
		"deadbeefcafebabe",
		"ffffffffffffffff",
		"global",
	])("accepts %s", (k) => {
		expect(() => assertHashedRepoKey(k)).not.toThrow();
	});

	it.each([
		"",
		"Favro",
		"ai-cortex",
		"fav-162958",
		"0123456789ABCDEF", // uppercase
		"0123456789abcde",  // 15
		"0123456789abcdef0", // 17
		"/abs/path",
		"../traversal",
		"global/",
	])("rejects %s", (k) => {
		expect(() => assertHashedRepoKey(k)).toThrow(RepoKeyError);
	});
});

describe("getCacheDir invariant", () => {
	it("throws RepoKeyError for invalid input", () => {
		expect(() => getCacheDir("Favro")).toThrow(RepoKeyError);
	});

	it("returns a path for valid input", () => {
		const dir = getCacheDir("0123456789abcdef");
		expect(dir.endsWith("0123456789abcdef")).toBe(true);
	});
});
