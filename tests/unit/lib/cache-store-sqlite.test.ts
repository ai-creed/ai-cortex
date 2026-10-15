// tests/unit/lib/cache-store-sqlite.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	openStructuralDb,
	STORE_FORMAT_VERSION,
	replaceAll,
	assembleCache,
	readFromDb,
	majorOf,
	transcodeCacheToDb,
	setTranscodeTestHooks,
	isNavlessCache,
} from "../../../src/lib/cache-store-sqlite.js";
import { seqDbPathFor } from "../../../src/lib/seq-lock.js";
import { getCacheDbFilePath, writeCache } from "../../../src/lib/cache-store.js";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-sqlite-"));
});
afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function richCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		symbols: [
			{ qualifiedName: "foo", name: "foo", file: "src/a.ts", kind: "function", exported: true, isDefaultExport: false, isDeclarationOnly: false, range: { line: 10, column: 1, endLine: 12, endColumn: 2 }, nameRange: { line: 10, column: 17, endLine: 10, endColumn: 19 } },
			{ qualifiedName: "C", name: "C", file: "src/b.ts", kind: "class", exported: true, isDefaultExport: false, isDeclarationOnly: false, range: { line: 1, column: 1, endLine: 5, endColumn: 2 }, nameRange: { line: 1, column: 14, endLine: 1, endColumn: 14 } },
			{ qualifiedName: "C.bar", name: "bar", file: "src/b.ts", kind: "method", containerQualifiedName: "C", exported: true, isDefaultExport: false, isDeclarationOnly: true, range: { line: 3, column: 3, endLine: 3, endColumn: 12 }, nameRange: { line: 3, column: 3, endLine: 3, endColumn: 5 } },
		],
		refs: [
			{ file: "src/a.ts", name: "bar", kind: "call", range: { line: 11, column: 5, endLine: 11, endColumn: 7 }, to: "src/b.ts::C.bar", from: "src/a.ts::foo" },
			{ file: "src/a.ts", name: "Nope", kind: "type", range: { line: 11, column: 10, endLine: 11, endColumn: 13 } },
		],
		reexports: [{ file: "src/a.ts", exportedName: "bar2", sourceName: "bar", specifier: "./b" }],
		indexSeq: 0,
		contentFingerprint: "cf-123",
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-05-01T00:00:00.000Z",
		fingerprint: "fp-abc",
		packageMeta: { name: "demo", version: "2.1.0", framework: "node" },
		entryFiles: ["src/index.ts"],
		files: [
			{ path: "src/a.ts", kind: "file", contentHash: "h1" },
			{ path: "src", kind: "dir" }, // no contentHash
		],
		docs: [{ path: "README.md", title: "Demo", body: "hello" }],
		imports: [{ from: "src/a.ts", to: "src/b.ts" }],
		calls: [{ from: "src/a.ts::foo", to: "src/b.ts::bar", kind: "call" }],
		functions: [
			{
				qualifiedName: "foo",
				file: "src/a.ts",
				exported: true,
				isDefaultExport: false,
				line: 10,
			},
			{
				qualifiedName: "bar",
				file: "src/b.ts",
				exported: false,
				isDefaultExport: false,
				line: 3,
				isDeclarationOnly: true,
			},
		],
		...overrides,
	};
}

describe("openStructuralDb", () => {
	it("creates all tables and sets user_version", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		try {
			const tables = (
				db
					.prepare("SELECT name FROM sqlite_master WHERE type='table'")
					.all() as Array<{ name: string }>
			)
				.map((r) => r.name)
				.sort();
			expect(tables).toEqual([
				"calls",
				"docs",
				"files",
				"functions",
				"imports",
				"meta",
				"reexports",
				"refs",
				"symbols",
			]);
			expect(db.pragma("user_version", { simple: true })).toBe(
				STORE_FORMAT_VERSION,
			);
		} finally {
			db.close();
		}
	});

	it("is idempotent on an existing db (CREATE TABLE IF NOT EXISTS)", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		openStructuralDb(dbPath).close();
		const db = openStructuralDb(dbPath);
		try {
			expect(db.pragma("user_version", { simple: true })).toBe(
				STORE_FORMAT_VERSION,
			);
		} finally {
			db.close();
		}
	});
});

describe("replaceAll + assembleCache", () => {
	it("round-trips a RepoCache (deep-equal)", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		try {
			const input = richCache();
			replaceAll(db, input);
			expect(assembleCache(db)).toEqual(input);
		} finally {
			db.close();
		}
	});

	it("round-trips dirtyAtIndex when present", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		try {
			const input = richCache({ dirtyAtIndex: true });
			replaceAll(db, input);
			expect(assembleCache(db)).toEqual(input);
		} finally {
			db.close();
		}
	});

	it("is a full replace, not an append (idempotent rows)", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		try {
			const input = richCache();
			replaceAll(db, input);
			replaceAll(db, input);
			expect(db.prepare("SELECT COUNT(*) c FROM functions").get()).toEqual({
				c: 2,
			});
			expect(db.prepare("SELECT COUNT(*) c FROM calls").get()).toEqual({ c: 1 });
			expect(db.prepare("SELECT COUNT(*) c FROM files").get()).toEqual({ c: 2 });
		} finally {
			db.close();
		}
	});
});

describe("readFromDb", () => {
	it("reads a valid db back into a RepoCache", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		const input = richCache();
		replaceAll(db, input);
		db.close();
		expect(readFromDb(dbPath)).toEqual(input);
	});

	it("returns null on store-format (user_version) mismatch", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(db, richCache());
		db.pragma("user_version = 999");
		db.close();
		expect(readFromDb(dbPath)).toBeNull();
	});

	it("returns null on incompatible content schemaVersion (different major)", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(db, richCache({ schemaVersion: "2" as RepoCache["schemaVersion"] }));
		db.close();
		expect(readFromDb(dbPath)).toBeNull();
	});

	// Spec A1: ai-cortex readers require an exact schemaVersion match.
	it("rejects a same-major different-minor schemaVersion (3.2 exact gate)", () => {
		const compatible = `${majorOf(SCHEMA_VERSION)}.999`;
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(
			db,
			richCache({ schemaVersion: compatible as RepoCache["schemaVersion"] }),
		);
		db.close();
		expect(readFromDb(dbPath)).toBeNull();
	});
});

describe("readFromDb nav option (Ruling 12)", () => {
	it("nav: false returns empty nav arrays and keeps every other field", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		const input = richCache();
		replaceAll(db, input);
		db.close();
		const lean = readFromDb(dbPath, { nav: false });
		expect(lean).toEqual({ ...input, symbols: [], refs: [], reexports: [] });
		expect(isNavlessCache(lean!)).toBe(true);
		const full = readFromDb(dbPath);
		expect(full).toEqual(input);
		expect(isNavlessCache(full!)).toBe(false);
	});

	it("a cache read with nav: false can never be written back", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 }));
		const lean = readFromDb(dbPath, { nav: false })!;
		expect(() => transcodeCacheToDb(lean, path.join(tmpDir, "other.db"))).toThrow(/nav tables/);
		await expect(writeCache(lean)).rejects.toThrow(/nav tables/);
		expect(fs.existsSync(path.join(tmpDir, "other.db"))).toBe(false);
		// The published store still carries its nav rows and its sequence value.
		expect(readFromDb(dbPath)).toEqual({ ...richCache(), indexSeq: 1 });
	});
});

describe("transcodeCacheToDb", () => {
	it("writes a self-contained .db (no -wal/-shm/build-dir residue) readable by readFromDb", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const input = richCache();
		transcodeCacheToDb(input, dbPath);
		expect(fs.existsSync(dbPath)).toBe(true);
		expect(fs.existsSync(dbPath + "-wal")).toBe(false);
		expect(fs.existsSync(dbPath + "-shm")).toBe(false);
		// No residue beyond the store and its sequence sidecar.
		const residue = fs
			.readdirSync(tmpDir)
			.filter((f) => f !== "wk.db" && f !== "wk.seq.db");
		expect(residue).toEqual([]);
		expect(readFromDb(dbPath)).toEqual(input);
	});

	it("builds in a PRIVATE temp dir, never a shared sibling `<dbPath>.tmp` path", () => {
		// A foreign process's in-flight file at a guessable shared name must be left
		// untouched: this proves two processes cannot collide on one tmp artifact.
		const dbPath = path.join(tmpDir, "wk.db");
		const foreign = dbPath + ".tmp";
		fs.writeFileSync(foreign, "another-process-in-flight");
		transcodeCacheToDb(richCache(), dbPath);
		expect(readFromDb(dbPath)).not.toBeNull();
		expect(fs.readFileSync(foreign, "utf8")).toBe("another-process-in-flight");
	});

	// True concurrency (spec Section 6: "concurrent transcode yields a single
	// valid .db, no corruption"). Eight real OS PROCESSES race transcodes of the
	// SAME cache onto the SAME dbPath -- matching production (multiple cortex
	// processes on one worktree). Each attempt builds in its own OS-unique
	// `fs.mkdtempSync` dir, then atomically renames over dbPath, so last-writer-wins
	// leaves exactly one complete, valid db and no residue regardless of
	// interleaving. Children run TS via the tsx CLI binary, which resolves the
	// whole `.js`->`.ts` import graph (worker `--import tsx` does not).
	it("survives 8 concurrent transcode processes onto the same dbPath", async () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const cache = richCache();
		const srcAbs = path
			.resolve(process.cwd(), "src/lib/cache-store-sqlite.ts")
			.split(path.sep)
			.join("/");
		const scriptSrc = `
      import { transcodeCacheToDb } from ${JSON.stringify(srcAbs)};
      transcodeCacheToDb(JSON.parse(process.argv[2]), process.argv[3]);
    `;
		const scriptPath = path.join(tmpDir, "transcode-proc.ts");
		fs.writeFileSync(scriptPath, scriptSrc);
		const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
		const payload = JSON.stringify(cache);

		await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(tsxBin, [scriptPath, payload, dbPath], {
							stdio: "ignore",
						});
						child.on("exit", (code) =>
							code === 0 ? resolve() : reject(new Error(`process exited ${code}`)),
						);
						child.on("error", reject);
					}),
			),
		);

		expect(readFromDb(dbPath)).toEqual({ ...cache, indexSeq: 8 });
		expect(seqOf(dbPath)).toBe(8);
		expect(sidecarN(dbPath)).toBe(8);
		expect(fs.existsSync(seqDbPathFor(dbPath) + "-journal")).toBe(false);
		const residue = fs
			.readdirSync(tmpDir)
			.filter((f) => f.startsWith(".transcode-"));
		expect(residue).toEqual([]);
	}, 30_000);
});

describe("v3.1 site/range round-trip", () => {
	it("persists and reconstructs CallEdge.site and FunctionNode ranges", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		try {
			const input = richCache({
				calls: [
					{
						from: "src/a.ts::foo",
						to: "src/b.ts::bar",
						kind: "call",
						site: { line: 2, column: 3, endLine: 2, endColumn: 18 },
					},
				],
				functions: [
					{
						qualifiedName: "foo",
						file: "src/a.ts",
						exported: true,
						isDefaultExport: false,
						line: 1,
						column: 1,
						endLine: 4,
						endColumn: 2,
					},
				],
			});
			replaceAll(db, input);
			expect(assembleCache(db)).toEqual(input);
		} finally {
			db.close();
		}
	});

	// Spec A1: exact-minor gate.
	it("rejects an exact Stage 1 schemaVersion '3' db", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(db, richCache({ schemaVersion: "3" as RepoCache["schemaVersion"] }));
		db.close();
		expect(readFromDb(dbPath)).toBeNull();
	});
});

describe("3.2 tables and meta", () => {
	it("round-trips symbols, refs, reexports, contentFingerprint (indexSeq placeholder 0)", () => {
		const db = openStructuralDb(path.join(tmpDir, "wk.db"));
		try {
			const cache = richCache();
			replaceAll(db, cache);
			expect(assembleCache(db)).toEqual(cache);
		} finally {
			db.close();
		}
	});

	it("replaceAll writes the indexSeq placeholder 0 regardless of cache.indexSeq (B4)", () => {
		const db = openStructuralDb(path.join(tmpDir, "wk.db"));
		try {
			replaceAll(db, richCache({ indexSeq: 7 }));
			expect((db.prepare("SELECT value FROM meta WHERE key = 'indexSeq'").get() as { value: string }).value).toBe("0");
			expect(assembleCache(db).indexSeq).toBe(0);
		} finally {
			db.close();
		}
	});

	it("writes container_key from containerQualifiedName and NULL to_key/from_key for unresolved refs", () => {
		const db = openStructuralDb(path.join(tmpDir, "wk.db"));
		try {
			replaceAll(db, richCache());
			const row = db.prepare("SELECT key, container_key, name_line, name_col FROM symbols WHERE qualified_name = 'C.bar'").get() as { key: string; container_key: string; name_line: number; name_col: number };
			expect(row).toEqual({ key: "src/b.ts::C.bar", container_key: "src/b.ts::C", name_line: 3, name_col: 3 });
			const unresolved = db.prepare("SELECT to_key, from_key FROM refs WHERE name = 'Nope'").get() as { to_key: string | null; from_key: string | null };
			expect(unresolved).toEqual({ to_key: null, from_key: null });
		} finally {
			db.close();
		}
	});

	it("writes navCapabilities JSON naming refs as the references table", () => {
		const db = openStructuralDb(path.join(tmpDir, "wk.db"));
		try {
			replaceAll(db, richCache());
			const raw = (db.prepare("SELECT value FROM meta WHERE key = 'navCapabilities'").get() as { value: string }).value;
			const caps = JSON.parse(raw);
			expect(caps).toMatchObject({ symbols: true, references: true, referencesTable: "refs" });
			expect(caps.symbolKinds).toContain("interface");
			expect(caps.referenceKinds).toContain("type");
			expect(caps.referenceKinds).not.toContain("read");
		} finally {
			db.close();
		}
	});

	it("every functions row has a symbols row with the same key and declaration range", () => {
		const db = openStructuralDb(path.join(tmpDir, "wk.db"));
		try {
			replaceAll(db, richCache({ functions: [{ qualifiedName: "foo", file: "src/a.ts", exported: true, isDefaultExport: false, line: 10, column: 1, endLine: 12, endColumn: 2, isDeclarationOnly: false }] }));
			const missing = db.prepare(`SELECT f.file || '::' || f.qualified_name AS k FROM functions f
				LEFT JOIN symbols s ON s.key = f.file || '::' || f.qualified_name AND s.line = f.line AND s.col = f.col AND s.end_line = f.end_line AND s.end_col = f.end_col
				WHERE s.key IS NULL`).all();
			expect(missing).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("rejects a store whose meta.schemaVersion is a different minor (exact match required)", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(db, richCache());
		db.prepare("UPDATE meta SET value = '3.1' WHERE key = 'schemaVersion'").run();
		db.close();
		expect(readFromDb(dbPath)).toBeNull();
	});

	it("rejects a user_version = 1 store", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(db, richCache());
		db.pragma("user_version = 1");
		db.close();
		expect(readFromDb(dbPath)).toBeNull();
	});
});

// writeCache resolves the store path from AI_CORTEX_CACHE_HOME (pinned to a
// session tmpdir by tests/helpers/isolate-cache-home.ts). richCache() always
// uses the same repoKey/worktreeKey, so clear that cache dir before each test or
// the sidecar sequence leaks between cases.
const CANON = () => getCacheDbFilePath(richCache().repoKey, richCache().worktreeKey);
beforeEach(() => fs.rmSync(path.dirname(CANON()), { recursive: true, force: true }));

function seqOf(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return Number((db.prepare("SELECT value FROM meta WHERE key = 'indexSeq'").get() as { value: string }).value);
	} finally {
		db.close();
	}
}
function sidecarN(dbPath: string): number {
	const db = new Database(seqDbPathFor(dbPath), { readonly: true });
	try {
		return (db.prepare("SELECT n FROM seq").get() as { n: number }).n;
	} finally {
		db.close();
	}
}

describe("sequence commit (B4)", () => {
	it("consecutive writeCache calls publish 1, 2, 3 and the sidecar tracks (production path)", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 }));
		expect(seqOf(dbPath)).toBe(1);
		await writeCache(richCache({ indexSeq: 0 }));
		expect(seqOf(dbPath)).toBe(2);
		const c = richCache({ indexSeq: 0 });
		await writeCache(c);
		expect(seqOf(dbPath)).toBe(3);
		expect(c.indexSeq).toBe(3);
		expect(sidecarN(dbPath)).toBe(3);
		expect(fs.existsSync(seqDbPathFor(dbPath) + "-journal")).toBe(false);
	});

	it("writeCache over a user_version=1 store with no sidecar (pre-3.2 layout) starts at 1", async () => {
		const cache = richCache({ indexSeq: 0 });
		const dbPath = CANON();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const old = openStructuralDb(dbPath);
		replaceAll(old, richCache());
		old.prepare("UPDATE meta SET value = '41' WHERE key = 'indexSeq'").run();
		old.pragma("user_version = 1");
		old.close();
		fs.rmSync(seqDbPathFor(dbPath), { force: true });
		await writeCache(cache); // production path: transcode + sequence commit + sidecar json
		expect(seqOf(dbPath)).toBe(1);
		expect(cache.indexSeq).toBe(1);
	});

	it("writeCache continues from the store when the sidecar is deleted, and from the sidecar when the store is deleted", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 }));
		await writeCache(richCache({ indexSeq: 0 })); // 2
		fs.rmSync(seqDbPathFor(dbPath));
		await writeCache(richCache({ indexSeq: 0 }));
		expect(seqOf(dbPath)).toBe(3); // max(sidecar absent -> 0, canonical 2) + 1
		fs.rmSync(dbPath);
		await writeCache(richCache({ indexSeq: 0 }));
		expect(seqOf(dbPath)).toBe(4); // max(sidecar 3, canonical absent -> 0) + 1
	});

	it("a throw after rename inside writeCache rolls the sidecar back", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 })); // 1
		setTranscodeTestHooks({ afterRename: () => { throw new Error("simulated crash after rename"); } });
		try {
			await expect(writeCache(richCache({ indexSeq: 0 }))).rejects.toThrow("simulated crash");
		} finally {
			setTranscodeTestHooks(null);
		}
		expect(seqOf(dbPath)).toBe(2); // published before the throw
		expect(sidecarN(dbPath)).toBe(1); // rolled back
	});

	it("a child writeCache killed by process.exit between rename and commit never causes a reused value", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 })); // 1
		const storeSrc = path.resolve(process.cwd(), "src/lib/cache-store-sqlite.ts").split(path.sep).join("/");
		const cacheStoreSrc = path.resolve(process.cwd(), "src/lib/cache-store.ts").split(path.sep).join("/");
		const crasher = path.join(tmpDir, "crash-after-rename.mts"); // .mts: ESM, so top-level await works
		fs.writeFileSync(crasher, `
      import { setTranscodeTestHooks } from ${JSON.stringify(storeSrc)};
      import { writeCache } from ${JSON.stringify(cacheStoreSrc)};
      setTranscodeTestHooks({ afterRename: () => process.exit(0) }); // hard exit: no COMMIT, no ROLLBACK
      await writeCache(JSON.parse(process.argv[2]));
      process.stdout.write("unreachable");
    `);
		const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
		await new Promise<void>((resolve, reject) => {
			// env is inherited, so the child shares AI_CORTEX_CACHE_HOME and writes the same dbPath
			const c = spawn(tsxBin, [crasher, JSON.stringify(richCache({ indexSeq: 0 }))], { stdio: "ignore" });
			c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
		});
		expect(seqOf(dbPath)).toBe(2); // the renamed store carries the stamped value
		expect(sidecarN(dbPath)).toBe(1); // SQLite rolled the uncommitted UPDATE back via the hot journal
		await writeCache(richCache({ indexSeq: 0 }));
		expect(seqOf(dbPath)).toBe(3); // max(sidecar 1, canonical 2) + 1
		expect(sidecarN(dbPath)).toBe(3);
	}, 20_000);

	it("a holder killed mid-section does not block the next writeCache", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 })); // 1
		const seqSrc = path.resolve(process.cwd(), "src/lib/seq-lock.ts").split(path.sep).join("/");
		const holder = path.join(tmpDir, "holder.ts");
		fs.writeFileSync(holder, `
      import { withSequenceLock } from ${JSON.stringify(seqSrc)};
      withSequenceLock(process.argv[2], () => { process.stdout.write("held " + process.pid + "\\n"); const end = Date.now() + 60_000; while (Date.now() < end) {} });
    `);
		const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
		const child = spawn(tsxBin, [holder, dbPath], { stdio: ["ignore", "pipe", "ignore"] });
		const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
		let out = "";
		await new Promise<void>((resolve) => child.stdout!.on("data", (d) => { out += d; if (/held \d+\n/.test(out)) resolve(); }));
		// The tsx CLI runs the script in a grandchild node process, and SIGKILL on the
		// wrapper cannot be relayed, so kill the process that actually holds the lock.
		process.kill(Number(/held (\d+)/.exec(out)![1]), "SIGKILL");
		await exited;
		const t0 = Date.now();
		await writeCache(richCache({ indexSeq: 0 }));
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(seqOf(dbPath)).toBe(2);
	}, 20_000);

	it("two writeCache writers both wait behind a held lock, then publish distinct increasing values", async () => {
		const dbPath = CANON();
		await writeCache(richCache({ indexSeq: 0 })); // 1
		const seqSrc = path.resolve(process.cwd(), "src/lib/seq-lock.ts").split(path.sep).join("/");
		const storeSrc = path.resolve(process.cwd(), "src/lib/cache-store-sqlite.ts").split(path.sep).join("/");
		const cacheStoreSrc = path.resolve(process.cwd(), "src/lib/cache-store.ts").split(path.sep).join("/");
		const holder = path.join(tmpDir, "holder.ts");
		fs.writeFileSync(holder, `
      import { withSequenceLock } from ${JSON.stringify(seqSrc)};
      withSequenceLock(process.argv[2], () => { process.stdout.write("held " + process.pid + "\\n"); const end = Date.now() + 60_000; while (Date.now() < end) {} });
    `);
		const writer = path.join(tmpDir, "writer.mts"); // .mts: ESM, so top-level await works
		fs.writeFileSync(writer, `
      import { setTranscodeTestHooks } from ${JSON.stringify(storeSrc)};
      import { writeCache } from ${JSON.stringify(cacheStoreSrc)};
      setTranscodeTestHooks({ beforeLock: () => process.stdout.write("before-lock\\n") });
      // env is inherited, so the child shares AI_CORTEX_CACHE_HOME and writes the same canonical dbPath
      const c = JSON.parse(process.argv[2]); await writeCache(c); process.stdout.write("published " + c.indexSeq + "\\n");
    `);
		const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
		const spawnOut = (file: string, args: string[]) => {
			const c = spawn(tsxBin, [file, ...args], { stdio: ["ignore", "pipe", "inherit"] });
			let out = "";
			c.stdout!.on("data", (d) => (out += d));
			const waitFor = (token: string) => new Promise<void>((resolve) => { const tick = () => (out.includes(token) ? resolve() : setTimeout(tick, 10)); tick(); });
			const exited = new Promise<number | null>((resolve) => c.on("close", (code) => resolve(code))); // "close" fires after stdio ends
			// Only complete lines count; drop an incomplete trailing line.
			return { c, waitFor, exited, out: () => out.slice(0, out.lastIndexOf("\n") + 1) };
		};
		const h = spawnOut(holder, [dbPath]);
		await h.waitFor("\n"); // the whole "held <pid>" line has arrived
		// The tsx CLI runs the script in a grandchild node process; this is the lock holder's pid.
		const holderPid = Number(/held (\d+)/.exec(h.out())![1]);
		const killHolder = () => {
			try {
				process.kill(holderPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		};
		try {
			const w1 = spawnOut(writer, [JSON.stringify(richCache({ indexSeq: 0 }))]);
			const w2 = spawnOut(writer, [JSON.stringify(richCache({ indexSeq: 0 }))]);
			await Promise.all([w1.waitFor("before-lock"), w2.waitFor("before-lock")]);
			// Both are now inside withSequenceLock's busy handler. Prove they wait.
			await new Promise((r) => setTimeout(r, 500));
			expect(w1.out()).not.toContain("published");
			expect(w2.out()).not.toContain("published");
			expect(seqOf(dbPath)).toBe(1);
			killHolder();
			await Promise.all([h.exited, w1.exited, w2.exited]);
			const vals = [w1.out(), w2.out()].map((o) => Number(/published (\d+)/.exec(o)![1])).sort();
			expect(vals).toEqual([2, 3]);
			expect(seqOf(dbPath)).toBe(3);
			expect(sidecarN(dbPath)).toBe(3);
		} finally {
			killHolder(); // never leave a spinning holder behind when an assertion fails
		}
	}, 30_000);
});
