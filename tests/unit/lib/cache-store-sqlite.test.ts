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
} from "../../../src/lib/cache-store-sqlite.js";
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

	it("accepts a compatible same-major content schemaVersion", () => {
		// e.g. current major is "3"; a "3.x" db is still readable.
		const compatible = `${majorOf(SCHEMA_VERSION)}.999`;
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(
			db,
			richCache({ schemaVersion: compatible as RepoCache["schemaVersion"] }),
		);
		db.close();
		expect(readFromDb(dbPath)).not.toBeNull();
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
		// No residual private build dirs (named `.transcode-XXXXXX`).
		const residue = fs
			.readdirSync(tmpDir)
			.filter((f) => f.startsWith(".transcode-"));
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

		expect(readFromDb(dbPath)).toEqual(cache);
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

	it("major-only invalidation: an EXACT Stage 1 schemaVersion '3' db is still read, not nuked", () => {
		// A v3 db (no site/range columns populated) written by Stage 1 must remain
		// readable under v3.1 because invalidation keys off the MAJOR version only.
		// Use the literal "3", not `${major}.999`, to catch a regression that
		// rejects the exact Stage 1 value.
		const dbPath = path.join(tmpDir, "wk.db");
		const db = openStructuralDb(dbPath);
		replaceAll(db, richCache({ schemaVersion: "3" as RepoCache["schemaVersion"] }));
		db.close();
		const read = readFromDb(dbPath);
		expect(read).not.toBeNull();
		expect(read!.schemaVersion).toBe("3");
	});
});
