import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession, writeAllChunks, writeChunkVectors } from "../../../../src/lib/history/store.js";
import { searchSession } from "../../../../src/lib/history/search.js";
import { HISTORY_SCHEMA_VERSION } from "../../../../src/lib/history/types.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-search-sem-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function rec(): SessionRecord {
	return {
		version: HISTORY_SCHEMA_VERSION,
		id: "s1",
		startedAt: "x",
		endedAt: null,
		turnCount: 1,
		lastProcessedTurn: 0,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "x",
		summary: "",
		evidence: { toolCalls: [], filePaths: [], userPrompts: [], corrections: [] },
		chunks: [
			{ id: 0, tokenStart: 0, tokenEnd: 1, preview: "alpha" },
			{ id: 1, tokenStart: 1, tokenEnd: 2, preview: "beta" },
		],
	};
}

describe("searchSession (semantic chunks)", () => {
	it("returns rawChunk hits sorted by similarity to query embedding", async () => {
		writeSession("REPO", rec());
		writeAllChunks("REPO", "s1", [
			{ id: 0, text: "alpha text" },
			{ id: 1, text: "beta text" },
		]);
		writeChunkVectors("REPO", "s1", {
			modelName: "TEST",
			dim: 2,
			chunks: [
				{ id: 0, text: "alpha text", vector: Float32Array.from([1, 0]) },
				{ id: 1, text: "beta text", vector: Float32Array.from([0, 1]) },
			],
		});
		const hits = await searchSession({
			repoKey: "REPO",
			sessionId: "s1",
			query: "alpha",
			embedQuery: async () => ({ vector: Float32Array.from([1, 0]), modelName: "TEST" }),
		});
		const chunkHits = hits.filter((h) => h.kind === "rawChunk");
		expect(chunkHits[0].text).toContain("alpha");
	});
});
