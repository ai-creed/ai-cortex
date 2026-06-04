import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { transcodeCacheToDb } from "../../../src/lib/cache-store-sqlite.js";
import {
	queryBlastRadius,
	queryBlastRadiusDb,
} from "../../../src/lib/blast-radius.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-blastdb-"));
});
afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildDb(cache: RepoCache): string {
	// Use the production write path (checkpoint + strip -wal/-shm) so the db is a
	// clean self-contained file, exactly as writeCache/transcode produce it.
	const dbPath = path.join(tmpDir, "wk.db");
	transcodeCacheToDb(cache, dbPath);
	return dbPath;
}

function cacheOf(over: Partial<RepoCache>): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/r",
		indexedAt: "t",
		fingerprint: "f",
		packageMeta: { name: "n", version: "1", framework: null },
		entryFiles: [],
		files: [],
		docs: [],
		imports: [],
		calls: [],
		functions: [],
		...over,
	};
}

const FNS = [
	{ qualifiedName: "target", file: "t.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "mid", file: "m.ts", exported: false, isDefaultExport: false, line: 1 },
	{ qualifiedName: "top", file: "p.ts", exported: true, isDefaultExport: false, line: 1 },
];

describe("queryBlastRadiusDb golden parity", () => {
	it("matches the in-memory queryBlastRadius across a 2-hop chain", () => {
		const cache = cacheOf({
			functions: FNS,
			calls: [
				{ from: "m.ts::mid", to: "t.ts::target", kind: "call" },
				{ from: "p.ts::top", to: "m.ts::mid", kind: "call" },
				{ from: "x.ts::other", to: "::target", kind: "call" }, // unresolved, same name
			],
		});
		const target = { qualifiedName: "target", file: "t.ts" };
		const dbPath = buildDb(cache);
		expect(queryBlastRadiusDb(dbPath, target)).toEqual(
			queryBlastRadius(target, cache.calls, cache.functions),
		);
	});

	it("matches under a cycle and respects maxHops", () => {
		const cache = cacheOf({
			functions: FNS,
			calls: [
				{ from: "m.ts::mid", to: "t.ts::target", kind: "call" },
				{ from: "t.ts::target", to: "m.ts::mid", kind: "call" }, // cycle
				{ from: "p.ts::top", to: "m.ts::mid", kind: "call" },
			],
		});
		const target = { qualifiedName: "target", file: "t.ts" };
		const dbPath = buildDb(cache);
		expect(queryBlastRadiusDb(dbPath, target, { maxHops: 1 })).toEqual(
			queryBlastRadius(target, cache.calls, cache.functions, { maxHops: 1 }),
		);
		expect(queryBlastRadiusDb(dbPath, target, { maxHops: 5 })).toEqual(
			queryBlastRadius(target, cache.calls, cache.functions, { maxHops: 5 }),
		);
	});

	it("matches overload + dotted method unresolved counting", () => {
		const cache = cacheOf({
			functions: [
				{ qualifiedName: "Ranker.score", file: "r.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "Ranker.score", file: "r.ts", exported: false, isDefaultExport: false, line: 9 },
				{ qualifiedName: "caller", file: "c.ts", exported: false, isDefaultExport: false, line: 1 },
			],
			calls: [
				{ from: "c.ts::caller", to: "r.ts::Ranker.score", kind: "method" },
				{ from: "z.ts::z", to: "::score", kind: "method" }, // unresolved method portion
				{ from: "z.ts::z2", to: "::Ranker.score", kind: "method" }, // unresolved full
			],
		});
		const target = { qualifiedName: "Ranker.score", file: "r.ts" };
		const dbPath = buildDb(cache);
		expect(queryBlastRadiusDb(dbPath, target)).toEqual(
			queryBlastRadius(target, cache.calls, cache.functions),
		);
	});

	it("leaves no -wal/-shm residue (readonly open)", () => {
		const cache = cacheOf({ functions: FNS, calls: [] });
		const dbPath = buildDb(cache);
		queryBlastRadiusDb(dbPath, { qualifiedName: "target", file: "t.ts" });
		expect(fs.existsSync(dbPath + "-wal")).toBe(false);
		expect(fs.existsSync(dbPath + "-shm")).toBe(false);
	});
});

describe("queryBlastRadiusDb enrichment", () => {
	it("carries target.range, hit.range, and deterministic callSite", () => {
		const cache = cacheOf({
			functions: [
				{ qualifiedName: "target", file: "t.ts", exported: true, isDefaultExport: false, line: 1, column: 1, endLine: 3, endColumn: 2 },
				{ qualifiedName: "mid", file: "m.ts", exported: false, isDefaultExport: false, line: 5, column: 1, endLine: 9, endColumn: 2 },
			],
			calls: [
				// two call sites mid -> target; smallest (line,col) must win
				{ from: "m.ts::mid", to: "t.ts::target", kind: "call", site: { line: 7, column: 9, endLine: 7, endColumn: 20 } },
				{ from: "m.ts::mid", to: "t.ts::target", kind: "call", site: { line: 6, column: 3, endLine: 6, endColumn: 14 } },
			],
		});
		const dbPath = buildDb(cache);
		const res = queryBlastRadiusDb(dbPath, { qualifiedName: "target", file: "t.ts" });
		expect(res.target.range).toEqual({ line: 1, column: 1, endLine: 3, endColumn: 2 });
		const hit = res.tiers[0]!.hits[0]!;
		expect(hit.range).toEqual({ line: 5, column: 1, endLine: 9, endColumn: 2 });
		expect(hit.callSite).toEqual({ line: 6, column: 3, endLine: 6, endColumn: 14 });
	});

	it("omits callSite and range when the discovering edge / function has none", () => {
		const cache = cacheOf({
			functions: [
				{ qualifiedName: "target", file: "t.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "mid", file: "m.ts", exported: false, isDefaultExport: false, line: 1 },
			],
			calls: [{ from: "m.ts::mid", to: "t.ts::target", kind: "call" }],
		});
		const dbPath = buildDb(cache);
		const hit = queryBlastRadiusDb(dbPath, { qualifiedName: "target", file: "t.ts" }).tiers[0]!.hits[0]!;
		expect(hit.callSite).toBeUndefined();
		expect(hit.range).toBeUndefined();
	});
});
