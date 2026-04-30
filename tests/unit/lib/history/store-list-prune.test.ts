import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listSessions,
	pruneSessionRaw,
	pruneSession,
	writeSession,
	writeAllChunks,
	writeChunkVectors,
	sessionDir,
	chunksJsonlPath,
} from "../../../../src/lib/history/store.js";
import { HISTORY_SCHEMA_VERSION } from "../../../../src/lib/history/types.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-listprune-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function rec(
	id: string,
	overrides: Partial<SessionRecord> = {},
): SessionRecord {
	return {
		version: HISTORY_SCHEMA_VERSION,
		id,
		startedAt: "2026-04-25T08:00:00.000Z",
		endedAt: null,
		turnCount: 1,
		lastProcessedTurn: 1,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "",
		summary: "",
		evidence: {
			toolCalls: [],
			filePaths: [],
			userPrompts: [],
			corrections: [],
		},
		chunks: [{ id: 0, tokenStart: 0, tokenEnd: 5, preview: "hi" }],
		...overrides,
	};
}

describe("listSessions", () => {
	it("returns empty when sessions dir missing", async () => {
		expect(await listSessions("REPO")).toEqual([]);
	});

	it("returns ids of sessions with session.json", async () => {
		await writeSession("REPO", rec("a"));
		await writeSession("REPO", rec("b"));
		expect((await listSessions("REPO")).sort()).toEqual(["a", "b"]);
	});

	it("skips session dirs with no session.json", async () => {
		await writeSession("REPO", rec("a"));
		fs.mkdirSync(sessionDir("REPO", "stranded"), { recursive: true });
		expect((await listSessions("REPO")).sort()).toEqual(["a"]);
	});
});

describe("pruneSessionRaw", () => {
	it("removes chunks.jsonl + .vectors.* and updates session.json", async () => {
		await writeSession("REPO", rec("a"));
		await writeAllChunks("REPO", "a", [{ id: 0, text: "x" }]);
		await writeChunkVectors("REPO", "a", {
			modelName: "M",
			dim: 1,
			chunks: [{ id: 0, text: "x", vector: Float32Array.from([1]) }],
		});

		await pruneSessionRaw("REPO", "a", "2026-05-25T00:00:00.000Z");

		expect(fs.existsSync(chunksJsonlPath("REPO", "a"))).toBe(false);
		expect(
			fs.existsSync(path.join(sessionDir("REPO", "a"), ".vectors.bin")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(sessionDir("REPO", "a"), ".vectors.meta.json")),
		).toBe(false);

		const updated = JSON.parse(
			fs.readFileSync(
				path.join(sessionDir("REPO", "a"), "session.json"),
				"utf8",
			),
		) as SessionRecord;
		expect(updated.hasRaw).toBe(false);
		expect(updated.rawDroppedAt).toBe("2026-05-25T00:00:00.000Z");
		expect(updated.chunks).toEqual([]);
	});
});

describe("pruneSession", () => {
	it("removes the entire session directory", async () => {
		await writeSession("REPO", rec("a"));
		await pruneSession("REPO", "a");
		expect(fs.existsSync(sessionDir("REPO", "a"))).toBe(false);
	});
});
