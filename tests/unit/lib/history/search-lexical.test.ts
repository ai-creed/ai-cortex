import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	writeSession,
	writeAllChunks,
} from "../../../../src/lib/history/store.js";
import { searchSession } from "../../../../src/lib/history/search.js";
import { HISTORY_SCHEMA_VERSION } from "../../../../src/lib/history/types.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-search-lex-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSession(): SessionRecord {
	return {
		version: HISTORY_SCHEMA_VERSION,
		id: "s1",
		startedAt: "2026-04-25T08:00:00.000Z",
		endedAt: "2026-04-25T08:30:00.000Z",
		turnCount: 3,
		lastProcessedTurn: 2,
		hasSummary: true,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/x.jsonl",
		summary: "Discussed auth middleware refactor.",
		evidence: {
			toolCalls: [{ turn: 1, name: "Read", args: "src/auth.ts" }],
			filePaths: [{ turn: 1, path: "src/auth.ts" }],
			userPrompts: [{ turn: 0, text: "look at the auth middleware" }],
			corrections: [{ turn: 2, text: "no, the OTHER middleware" }],
		},
		chunks: [{ id: 0, tokenStart: 0, tokenEnd: 5, preview: "auth talk" }],
	};
}

describe("searchSession (lexical)", () => {
	it("matches user prompt by substring", async () => {
		await writeSession("REPO", makeSession());
		await writeAllChunks("REPO", "s1", [
			{ id: 0, text: "auth talk in detail" },
		]);
		const hits = await searchSession({
			repoKey: "REPO",
			sessionId: "s1",
			query: "auth middleware",
		});
		expect(hits.some((h) => h.kind === "userPrompt")).toBe(true);
	});

	it("matches correction with high score (corrections weighted above prompts)", async () => {
		await writeSession("REPO", makeSession());
		const hits = await searchSession({
			repoKey: "REPO",
			sessionId: "s1",
			query: "OTHER middleware",
		});
		const correction = hits.find((h) => h.kind === "correction");
		const prompt = hits.find((h) => h.kind === "userPrompt");
		expect(correction).toBeDefined();
		if (correction && prompt) {
			expect(correction.score).toBeGreaterThan(prompt.score);
		}
	});

	it("matches file path in evidence", async () => {
		await writeSession("REPO", makeSession());
		const hits = await searchSession({
			repoKey: "REPO",
			sessionId: "s1",
			query: "src/auth.ts",
		});
		expect(hits.some((h) => h.kind === "filePath")).toBe(true);
	});

	it("matches summary text", async () => {
		await writeSession("REPO", makeSession());
		const hits = await searchSession({
			repoKey: "REPO",
			sessionId: "s1",
			query: "refactor",
		});
		expect(hits.some((h) => h.kind === "summary")).toBe(true);
	});

	it("returns empty array on no match", async () => {
		await writeSession("REPO", makeSession());
		const hits = await searchSession({
			repoKey: "REPO",
			sessionId: "s1",
			query: "completely unrelated",
		});
		expect(hits).toEqual([]);
	});
});
