import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { indexDbPath, memoriesDir } from "../../../../src/lib/memory/paths.js";
import { loadMemoryList } from "../../../../src/lib/stats/memory-browser.js";

const repoKey = "6d656d62726f7773"; // 16 hex
let originalCacheHome: string | undefined;
let tmp: string;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-browser-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function seedIndex(rows: Array<[string, string, string, string, number, string]>) {
	fs.mkdirSync(path.dirname(indexDbPath(repoKey)), { recursive: true });
	const db = new Database(indexDbPath(repoKey));
	db.exec(
		`CREATE TABLE memories (id TEXT PRIMARY KEY, type TEXT, status TEXT, title TEXT, pinned INTEGER, updated_at TEXT);`,
	);
	const ins = db.prepare(
		"INSERT INTO memories (id,type,status,title,pinned,updated_at) VALUES (?,?,?,?,?,?)",
	);
	for (const r of rows) ins.run(...r);
	db.close();
}

describe("loadMemoryList", () => {
	it("returns empty groups when the index is absent", () => {
		const g = loadMemoryList(repoKey);
		expect(g).toEqual({
			groups: [
				{ status: "active", count: 0, items: [] },
				{ status: "candidate", count: 0, items: [] },
				{ status: "deprecated", count: 0, items: [] },
			],
			error: null,
		});
	});

	it("groups by status in fixed order, excludes trashed/merged/stale/purged, carries pinned", () => {
		seedIndex([
			["a", "decision", "active", "A title", 1, "2026-05-10T00:00:00.000Z"],
			["b", "feedback", "candidate", "B title", 0, "2026-05-11T00:00:00.000Z"],
			["c", "project", "deprecated", "C title", 0, "2026-05-09T00:00:00.000Z"],
			["d", "gotcha", "trashed", "D title", 0, "2026-05-12T00:00:00.000Z"],
			["e", "user", "merged_into", "E title", 0, "2026-05-12T00:00:00.000Z"],
		]);
		const g = loadMemoryList(repoKey);
		expect(g.error).toBeNull();
		expect(g.groups.map((x) => [x.status, x.count])).toEqual([
			["active", 1],
			["candidate", 1],
			["deprecated", 1],
		]);
		expect(g.groups[0].items[0]).toEqual({
			id: "a",
			type: "decision",
			status: "active",
			title: "A title",
			updatedAt: "2026-05-10T00:00:00.000Z",
			pinned: true,
		});
		expect(g.groups[1].items[0].pinned).toBe(false);
	});

	it("does not create the memory dir/schema when the index is absent (read-only)", () => {
		loadMemoryList(repoKey);
		expect(fs.existsSync(indexDbPath(repoKey))).toBe(false);
		expect(fs.existsSync(memoriesDir(repoKey))).toBe(false);
	});

	it("returns a typed error string when the index is unreadable", () => {
		fs.mkdirSync(path.dirname(indexDbPath(repoKey)), { recursive: true });
		fs.writeFileSync(indexDbPath(repoKey), "not a sqlite file");
		const g = loadMemoryList(repoKey);
		expect(g.error).toMatch(/.+/);
		expect(g.groups.every((x) => x.count === 0)).toBe(true);
	});
});
