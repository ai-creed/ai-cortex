// tests/unit/lib/cache-store.test.ts
import { spawn, type ChildProcess } from "node:child_process";
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
	computeContentFingerprint,
	ensureValidDb,
	getCacheDbFilePath,
	getCacheDir,
	getCacheMetaFilePath,
	isWorktreeDirty,
	readCacheForWorktree,
	readFreshnessMeta,
	RepoKeyError,
	setEnsureValidDbTestHooks,
	writeCache,
} from "../../../src/lib/cache-store.js";
import { setTranscodeTestHooks } from "../../../src/lib/cache-store-sqlite.js";
import { seqDbPathFor } from "../../../src/lib/seq-lock.js";

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
		indexSeq: 0,
		contentFingerprint: "",
		symbols: [],
		refs: [],
		reexports: [],
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

		// The transcode's sequence commit publishes indexSeq 1 on a fresh path (B4).
		expect(result).toEqual({ ...cache, indexSeq: 1 });
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

	it("rejects a same-major older-minor legacy json: returns null, deletes json, creates no db (A1)", async () => {
		const cache = makeCache();
		const jsonPath = path.join(getCacheDir(cache.repoKey), cache.worktreeKey + ".json");
		fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
		fs.writeFileSync(jsonPath, JSON.stringify({ ...cache, schemaVersion: "3.1" }));
		expect(await ensureValidDb(cache.repoKey, cache.worktreeKey)).toBeNull();
		expect(fs.existsSync(jsonPath)).toBe(false);
		expect(fs.existsSync(getCacheDbFilePath(cache.repoKey, cache.worktreeKey))).toBe(false);
	});

	it("still transcodes a current-version legacy json with indexSeq 1 and takes no sidecar lock before the transcode", async () => {
		const cache = makeCache();
		const jsonPath = path.join(getCacheDir(cache.repoKey), cache.worktreeKey + ".json");
		fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
		fs.writeFileSync(jsonPath, JSON.stringify(cache));
		const dbPath = getCacheDbFilePath(cache.repoKey, cache.worktreeKey);
		const sidecar = seqDbPathFor(dbPath);
		// Ordering probe (spec C, fourth variant). Every withSequenceLock call opens
		// the sidecar database and therefore creates the file. The transcode's own
		// beforeLock hook fires immediately before the transcode takes the lock, so
		// if the sidecar already exists at that instant, ensureValidDb must have
		// locked earlier. Separately, ensureValidDb's beforeLock seam fires only on
		// the locked-invalidation branch, which a JSON-only cache must never enter.
		let sidecarExistedBeforeTranscodeLock: boolean | null = null;
		setTranscodeTestHooks({ beforeLock: () => { sidecarExistedBeforeTranscodeLock = fs.existsSync(sidecar); } });
		setEnsureValidDbTestHooks({ beforeLock: async () => { throw new Error("ensureValidDb entered the locked invalidation path for a JSON-only cache"); } });
		try {
			expect(await ensureValidDb(cache.repoKey, cache.worktreeKey)).toBe(dbPath);
		} finally {
			setTranscodeTestHooks(null);
			setEnsureValidDbTestHooks(null);
		}
		expect(sidecarExistedBeforeTranscodeLock).toBe(false); // the hook fired, and nothing had locked before it
		expect(fs.existsSync(sidecar)).toBe(true); // the transcode's own sequence commit created it afterwards
		expect(readFreshnessMeta(dbPath).indexSeq).toBe(1);
		expect(fs.existsSync(jsonPath)).toBe(false);
	});

	it("rejects a user_version=2 db whose meta.schemaVersion is 3.1", async () => {
		const cache = makeCache();
		const dbPath = getCacheDbFilePath(cache.repoKey, cache.worktreeKey);
		await writeCache(cache);
		const db = new Database(dbPath);
		db.prepare("UPDATE meta SET value = '3.1' WHERE key = 'schemaVersion'").run();
		db.close();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(await ensureValidDb(cache.repoKey, cache.worktreeKey)).toBeNull();
		} finally {
			stderrSpy.mockRestore();
		}
		expect(fs.existsSync(dbPath)).toBe(false);
		expect(fs.existsSync(seqDbPathFor(dbPath))).toBe(true); // sidecar survives invalidation
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

describe("ensureValidDb: concurrent upgrade (B4)", () => {
	const cacheStoreSrc = path.resolve(process.cwd(), "src/lib/cache-store.ts").split(path.sep).join("/");
	const sqliteStoreSrc = path.resolve(process.cwd(), "src/lib/cache-store-sqlite.ts").split(path.sep).join("/");
	const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
	let cacheHome: string;
	let childScript: string;
	let dbPath: string;
	let spawned: Child[] = [];

	// One child program, two modes. "check" runs ensureValidDb and reports. "write"
	// runs ensureValidDb, reports, optionally waits for writeGate, then calls
	// writeCache in ITS OWN process and reports the published value. pauseGate,
	// when non-empty, installs the ensureValidDb beforeLock seam: the hook prints
	// the "paused" marker and parks until the gate file exists. The first line is
	// the script's own pid (tsx runs it in a grandchild process), so cleanup can
	// kill a child left parked by a failed case.
	const CHILD = `
    import fs from "node:fs";
    import { ensureValidDb, writeCache, setEnsureValidDbTestHooks } from ${JSON.stringify(cacheStoreSrc)};
    process.stdout.write("pid " + process.pid + "\\n");
    const [,, mode, repoKey, worktreeKey, pauseGate, writeGate, cacheJson] = process.argv;
    const waitForFile = async (f) => { while (!fs.existsSync(f)) await new Promise((r) => setTimeout(r, 10)); };
    const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    if (pauseGate) setEnsureValidDbTestHooks({ beforeLock: async () => { process.stdout.write("paused\\n"); await waitForFile(pauseGate); } });
    const result = await ensureValidDb(repoKey, worktreeKey);
    emit({ result });
    if (mode === "write") {
      if (writeGate) await waitForFile(writeGate);
      const cache = JSON.parse(cacheJson);
      await writeCache(cache);
      emit({ indexSeq: cache.indexSeq });
    }
  `;

	type Child = {
		proc: ChildProcess;
		waitFor: (token: string) => Promise<void>;
		exited: Promise<number | null>;
		records: () => Array<Record<string, unknown>>; // parsed JSON lines seen so far, in order
		scriptPid: () => number | null;
	};
	function spawnScript(file: string, args: string[]): Child {
		const proc = spawn(tsxBin, [file, ...args], {
			// stderr is captured, not inherited, so the children's "reindexing"
			// notices stay out of the test output; it is included in failures.
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, AI_CORTEX_CACHE_HOME: cacheHome }, // same cache home as the parent's getCacheDbFilePath
		});
		let out = "";
		let err = "";
		proc.stdout!.on("data", (d) => (out += d));
		proc.stderr!.on("data", (d) => (err += d));
		const waitFor = (token: string) =>
			new Promise<void>((resolve, reject) => {
				const tick = () => (out.includes(token) ? resolve() : proc.exitCode !== null ? reject(new Error(`child exited before "${token}": ${out}${err}`)) : setTimeout(tick, 10));
				tick();
			});
		const exited = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code))); // "close" fires after stdio ends
		const records = () => out.split("\n").slice(0, out.endsWith("\n") ? undefined : -1).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>); // drop an incomplete trailing line
		const scriptPid = () => {
			const m = /^pid (\d+)$/m.exec(out);
			return m ? Number(m[1]) : null;
		};
		const child = { proc, waitFor, exited, records, scriptPid };
		spawned.push(child);
		return child;
	}
	function spawnChild(mode: "check" | "write", o: { pauseGate?: string; writeGate?: string; cache?: RepoCache } = {}): Child {
		const c = o.cache ?? makeCache();
		return spawnScript(childScript, [mode, c.repoKey, c.worktreeKey, o.pauseGate ?? "", o.writeGate ?? "", JSON.stringify(c)]);
	}
	const gate = (name: string) => path.join(tmpDir, `gate-${name}`);
	const open = (g: string) => fs.writeFileSync(g, "go");

	beforeEach(async () => {
		spawned = [];
		cacheHome = path.join(tmpDir, "cache-home");
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		childScript = path.join(tmpDir, "upgrade-child.mts"); // .mts: ESM, so top-level await works
		fs.writeFileSync(childScript, CHILD);
		// Start every case from a store that is invalid under 3.2 (user_version = 1)
		// with no sidecar, which is the pre-3.2 on-disk layout.
		const cache = makeCache();
		dbPath = getCacheDbFilePath(cache.repoKey, cache.worktreeKey);
		await writeCache(cache);
		const db = new Database(dbPath);
		db.pragma("user_version = 1");
		db.close();
		fs.rmSync(seqDbPathFor(dbPath), { force: true });
	});
	afterEach(async () => {
		process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
		// A failed case can leave a child parked on a gate; kill the script process
		// itself (tsx's grandchild) and the tsx wrapper, then wait for the exit.
		for (const c of spawned) {
			if (c.proc.exitCode !== null || c.proc.signalCode !== null) continue;
			const pid = c.scriptPid();
			if (pid !== null) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
			c.proc.kill("SIGKILL");
			await c.exited;
		}
	});

	it("B paused before the lock does not delete A's freshly upgraded store, and B's own later write publishes 2", async () => {
		const b = spawnChild("write", { pauseGate: gate("b-lock"), writeGate: gate("b-write") });
		await b.waitFor("paused"); // B saw user_version = 1 and is parked before taking the lock
		const a = spawnChild("write"); // A: discard under the lock, then publish 1
		await a.exited;
		expect(a.records()).toEqual([{ result: null }, { indexSeq: 1 }]);
		const before = fs.readFileSync(dbPath);
		open(gate("b-lock")); // B takes the lock; its recheck finds A's valid store
		await b.waitFor('"result"');
		expect(b.records()[0]).toEqual({ result: dbPath });
		expect(fs.readFileSync(dbPath).equals(before)).toBe(true); // byte-identical: B deleted nothing
		expect(readFreshnessMeta(dbPath).indexSeq).toBe(1);
		open(gate("b-write")); // B's own process now writes
		await b.exited;
		expect(b.records()[1]).toEqual({ indexSeq: 2 });
		expect(readFreshnessMeta(dbPath).indexSeq).toBe(2);
	}, 30_000);

	it("B blocks on the sidecar lock while the upgrader A is mid-commit, then observes A's store as valid", async () => {
		// Spec C: "B paused while A holds the sidecar lock mid-commit, asserting B
		// blocks and then observes A's store as valid". A is a writer whose
		// afterRename hook parks it INSIDE the critical section (after step 6,
		// before COMMIT) until a gate file appears. B first sees the invalid v1
		// store (unlocked check), then enters withSequenceLock and must block in
		// SQLite's busy handler because A holds the RESERVED lock.
		const writerFile = path.join(tmpDir, "mid-commit-writer.mts");
		fs.writeFileSync(writerFile, `
      import fs from "node:fs";
      import { writeCache } from ${JSON.stringify(cacheStoreSrc)};
      import { setTranscodeTestHooks } from ${JSON.stringify(sqliteStoreSrc)};
      process.stdout.write("pid " + process.pid + "\\n");
      setTranscodeTestHooks({ afterRename: () => { process.stdout.write("mid-commit\\n"); while (!fs.existsSync(process.argv[3])) { const end = Date.now() + 20; while (Date.now() < end) {} } } });
      await writeCache(JSON.parse(process.argv[2]));
      process.stdout.write("published\\n");
    `);
		// B must take its unlocked check BEFORE A renames the new store over the old
		// one, otherwise B's fast path sees a valid store and never enters the lock.
		const b = spawnChild("check", { pauseGate: gate("b-lock") });
		await b.waitFor("paused"); // B observed user_version = 1 and is parked before the lock
		const a = spawnScript(writerFile, [JSON.stringify(makeCache()), gate("a-commit")]);
		await a.waitFor("mid-commit"); // A has renamed the 3.2 store into place and still holds the lock
		open(gate("b-lock")); // B now calls withSequenceLock and must block
		await new Promise((r) => setTimeout(r, 500));
		expect(b.proc.exitCode).toBeNull(); // still blocked behind A
		expect(b.records()).toEqual([]); // no result yet
		expect(fs.existsSync(dbPath)).toBe(true); // A's store is in place, sequence not yet committed
		open(gate("a-commit")); // A commits and exits
		await a.waitFor("published");
		await b.exited;
		expect(b.records()).toEqual([{ result: dbPath }]); // locked recheck: valid, nothing deleted
		expect(readFreshnessMeta(dbPath).indexSeq).toBe(1);
		expect(fs.existsSync(dbPath)).toBe(true);
	}, 30_000);

	it("B released after A discarded but before A wrote: B's recheck finds absent and returns null, then A publishes 1 and B's own write publishes 2", async () => {
		const b = spawnChild("write", { pauseGate: gate("b-lock"), writeGate: gate("b-write") });
		await b.waitFor("paused");
		const a = spawnChild("write", { writeGate: gate("a-write") }); // A: discard under the lock, report, then wait before writing
		await a.waitFor('"result"');
		expect(a.records()).toEqual([{ result: null }]);
		expect(fs.existsSync(dbPath)).toBe(false); // A discarded the invalid store
		const sidecarBefore = fs.readFileSync(seqDbPathFor(dbPath)); // created by A's lock
		open(gate("b-lock")); // B's locked recheck finds the store absent
		await b.waitFor('"result"');
		expect(b.records()).toEqual([{ result: null }]); // fell through to the JSON branch: no JSON, so null
		expect(fs.existsSync(dbPath)).toBe(false);
		expect(fs.readFileSync(seqDbPathFor(dbPath)).equals(sidecarBefore)).toBe(true); // B deleted nothing, sidecar untouched
		open(gate("a-write")); // A publishes 1 from its own process
		await a.exited;
		expect(a.records()[1]).toEqual({ indexSeq: 1 });
		expect(readFreshnessMeta(dbPath).indexSeq).toBe(1);
		open(gate("b-write")); // B's own process publishes 2
		await b.exited;
		expect(b.records()[1]).toEqual({ indexSeq: 2 });
		expect(readFreshnessMeta(dbPath).indexSeq).toBe(2);
	}, 30_000);
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

describe("computeContentFingerprint", () => {
	it("is order-independent, changes with any content hash, ignores indexedAt", () => {
		const a = computeContentFingerprint([{ path: "b", kind: "file", contentHash: "2" }, { path: "a", kind: "file", contentHash: "1" }]);
		const b = computeContentFingerprint([{ path: "a", kind: "file", contentHash: "1" }, { path: "b", kind: "file", contentHash: "2" }]);
		const c = computeContentFingerprint([{ path: "a", kind: "file", contentHash: "X" }, { path: "b", kind: "file", contentHash: "2" }]);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{40}$/);
	});
});
