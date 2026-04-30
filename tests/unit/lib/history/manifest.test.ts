// tests/unit/lib/history/manifest.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/history/store.js");

import {
	listSessions,
	writeSession,
} from "../../../../src/lib/history/store.js";
import {
	appendManifestEntry,
	readManifest,
	pruneManifest,
} from "../../../../src/lib/history/manifest.js";
import { searchHistory } from "../../../../src/lib/history/search.js";
import type { ManifestEntry } from "../../../../src/lib/history/manifest.js";
import { HISTORY_SCHEMA_VERSION } from "../../../../src/lib/history/types.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-manifest-test-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("appendManifestEntry", () => {
	it("appends a JSONL line to manifest.jsonl", async () => {
		const entry: ManifestEntry = {
			id: "sess-abc",
			startedAt: "2026-04-29T10:00:00.000Z",
		};
		await appendManifestEntry("REPO1", entry);

		const manifestPath = path.join(
			tmp,
			".cache",
			"ai-cortex",
			"v1",
			"REPO1",
			"history",
			"manifest.jsonl",
		);
		expect(fs.existsSync(manifestPath)).toBe(true);
		const lines = fs.readFileSync(manifestPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual(entry);
	});

	it("appends a second entry on a new line", async () => {
		const e1: ManifestEntry = {
			id: "sess-1",
			startedAt: "2026-04-29T10:00:00.000Z",
		};
		const e2: ManifestEntry = {
			id: "sess-2",
			startedAt: "2026-04-29T11:00:00.000Z",
			endedAt: "2026-04-29T11:30:00.000Z",
		};
		await appendManifestEntry("REPO1", e1);
		await appendManifestEntry("REPO1", e2);

		const manifestPath = path.join(
			tmp,
			".cache",
			"ai-cortex",
			"v1",
			"REPO1",
			"history",
			"manifest.jsonl",
		);
		const lines = fs.readFileSync(manifestPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]!)).toEqual(e2);
	});
});

describe("readManifest", () => {
	it("returns empty array when manifest does not exist", async () => {
		const entries = await readManifest("REPO_NONE");
		expect(entries).toEqual([]);
	});

	it("parses all lines and returns array of entries", async () => {
		const e1: ManifestEntry = {
			id: "s1",
			startedAt: "2026-04-29T10:00:00.000Z",
		};
		const e2: ManifestEntry = {
			id: "s2",
			startedAt: "2026-04-29T11:00:00.000Z",
		};
		await appendManifestEntry("REPO2", e1);
		await appendManifestEntry("REPO2", e2);

		const entries = await readManifest("REPO2");
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual(e1);
		expect(entries[1]).toEqual(e2);
	});

	it("deduplicates by id, last-write-wins", async () => {
		const e1: ManifestEntry = {
			id: "s1",
			startedAt: "2026-04-29T10:00:00.000Z",
		};
		const e1Updated: ManifestEntry = {
			id: "s1",
			startedAt: "2026-04-29T10:00:00.000Z",
			endedAt: "2026-04-29T10:45:00.000Z",
		};
		await appendManifestEntry("REPO3", e1);
		await appendManifestEntry("REPO3", e1Updated);

		const entries = await readManifest("REPO3");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual(e1Updated);
	});
});

describe("pruneManifest", () => {
	it("removes entries whose IDs are not in activeSessions", async () => {
		await appendManifestEntry("REPO4", {
			id: "keep-me",
			startedAt: "2026-04-29T10:00:00.000Z",
		});
		await appendManifestEntry("REPO4", {
			id: "drop-me",
			startedAt: "2026-04-29T11:00:00.000Z",
		});

		await pruneManifest("REPO4", new Set(["keep-me"]));

		const entries = await readManifest("REPO4");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.id).toBe("keep-me");
	});

	it("leaves manifest empty when activeSessions is empty", async () => {
		await appendManifestEntry("REPO5", {
			id: "s1",
			startedAt: "2026-04-29T10:00:00.000Z",
		});
		await pruneManifest("REPO5", new Set());

		const entries = await readManifest("REPO5");
		expect(entries).toHaveLength(0);
	});

	it("is a no-op when manifest does not exist", async () => {
		// Should not throw
		await expect(
			pruneManifest("REPO_NONE", new Set(["s1"])),
		).resolves.toBeUndefined();
	});
});

describe("searchHistory — session enumeration via manifest", () => {
	function _makeSession(id: string): SessionRecord {
		return {
			version: HISTORY_SCHEMA_VERSION,
			id,
			startedAt: "2026-04-29T10:00:00.000Z",
			endedAt: "2026-04-29T10:30:00.000Z",
			turnCount: 1,
			lastProcessedTurn: 0,
			hasSummary: true,
			hasRaw: false,
			rawDroppedAt: null,
			transcriptPath: `/sessions/${id}.jsonl`,
			summary: `summary for ${id}`,
			evidence: {
				toolCalls: [],
				filePaths: [],
				userPrompts: [{ turn: 0, text: `task for ${id}` }],
				corrections: [],
			},
			chunks: [],
		};
	}

	it("uses manifest IDs for session enumeration when manifest exists", async () => {
		vi.mocked(writeSession).mockResolvedValue(undefined);

		// Populate manifest with one session
		await appendManifestEntry("REPOSRCH", {
			id: "sess-manifest",
			startedAt: "2026-04-29T10:00:00.000Z",
		});

		// search.ts should call readManifest and use those IDs
		// readSession will return null for non-existent sessions — that's fine, 0 hits
		vi.mocked(listSessions).mockResolvedValue(["sess-fallback"]);

		const result = await searchHistory({
			repoKey: "REPOSRCH",
			cwd: "/tmp",
			query: "task",
			scope: "project",
		});

		// manifest exists → listSessions should NOT have been called
		expect(vi.mocked(listSessions)).not.toHaveBeenCalled();
		expect(result.hits).toBeDefined();
	});

	it("falls back to listSessions when manifest is absent", async () => {
		vi.mocked(listSessions).mockResolvedValue([]);

		const result = await searchHistory({
			repoKey: "REPO_NO_MANIFEST",
			cwd: "/tmp",
			query: "task",
			scope: "project",
		});

		expect(vi.mocked(listSessions)).toHaveBeenCalledOnce();
		expect(result.hits).toEqual([]);
	});
});
