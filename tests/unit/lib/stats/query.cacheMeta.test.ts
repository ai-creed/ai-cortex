// tests/unit/lib/stats/query.cacheMeta.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheMeta } from "../../../../src/lib/stats/query.js";
import { cacheRoot } from "../../../../src/lib/stats/paths.js";

const REPO = "aabbccdd11223344";
// Global setup pins AI_CORTEX_CACHE_HOME; override per-test and restore it.
const SESSION_CACHE_HOME = process.env.AI_CORTEX_CACHE_HOME;
let tmpDir: string;

function repoDir(): string {
	return path.join(cacheRoot(), REPO);
}
function writeSidecar(worktreeKey: string, meta: Record<string, unknown>): void {
	fs.mkdirSync(repoDir(), { recursive: true });
	fs.writeFileSync(
		path.join(repoDir(), `${worktreeKey}.meta.json`),
		JSON.stringify(meta) + "\n",
	);
}
function writeManifest(
	worktreeKey: string,
	data: Record<string, unknown>,
): void {
	fs.mkdirSync(repoDir(), { recursive: true });
	fs.writeFileSync(
		path.join(repoDir(), `${worktreeKey}.json`),
		JSON.stringify(data),
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cachemeta-"));
	process.env.AI_CORTEX_CACHE_HOME = tmpDir;
});
afterEach(() => {
	process.env.AI_CORTEX_CACHE_HOME = SESSION_CACHE_HOME;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cacheMeta discovery (post-SQLite)", () => {
	it("discovers a migrated worktree from its sidecar alone (.db + .meta.json, no .json)", () => {
		fs.mkdirSync(repoDir(), { recursive: true });
		fs.writeFileSync(path.join(repoDir(), "wk1.db"), "binary-db-bytes");
		writeSidecar("wk1", {
			indexedAt: "2026-05-10T00:00:00.000Z",
			fingerprint: "fp1",
			fileCount: 42,
			name: "demo",
			worktreePath: "/repo",
		});
		const meta = cacheMeta(REPO);
		expect(meta.name).toBe("demo");
		expect(meta.fileCount).toBe(42);
		expect(meta.indexedAt).toBe("2026-05-10T00:00:00.000Z");
		expect(meta.fingerprint).toBe("fp1");
		expect(meta.worktreePath).toBe("/repo");
	});

	it("still resolves a legacy json-only worktree (no sidecar) and self-heals", () => {
		writeManifest("wk2", {
			indexedAt: "2026-05-11T00:00:00.000Z",
			fingerprint: "fp2",
			files: [{ path: "a" }, { path: "b" }],
			packageMeta: { name: "legacy" },
			worktreePath: "/l",
		});
		const meta = cacheMeta(REPO);
		expect(meta.name).toBe("legacy");
		expect(meta.fileCount).toBe(2);
		expect(fs.existsSync(path.join(repoDir(), "wk2.meta.json"))).toBe(true);
	});

	it("picks the most recent indexedAt across a mixed dir (migrated + legacy)", () => {
		writeSidecar("wk1", {
			indexedAt: "2026-05-01T00:00:00.000Z",
			name: "older",
			fileCount: 1,
			fingerprint: "a",
			worktreePath: "/a",
		});
		writeManifest("wk2", {
			indexedAt: "2026-06-01T00:00:00.000Z",
			files: [{ path: "x" }],
			packageMeta: { name: "newer" },
			worktreePath: "/b",
		});
		expect(cacheMeta(REPO).name).toBe("newer");
	});

	it("returns empty meta when the repo dir does not exist", () => {
		expect(cacheMeta("00000000ffffffff")).toEqual({
			indexedAt: null,
			fingerprint: null,
			fileCount: null,
			name: null,
			worktreePath: null,
		});
	});
});
