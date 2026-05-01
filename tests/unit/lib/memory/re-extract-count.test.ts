import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("re-extract-count");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

describe("reExtractCount", () => {
	it("starts at 0 for a fresh candidate", async () => {
		await writeSession(repoKey, {
			version: 2,
			id: "s-1",
			startedAt: "2026-04-30T00:00:00Z",
			endedAt: null,
			turnCount: 1,
			lastProcessedTurn: 1,
			hasSummary: false,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: "/tmp/x",
			summary: "",
			evidence: {
				toolCalls: [],
				filePaths: [],
				userPrompts: [
					{ turn: 1, text: "actually, always run pnpm typecheck" },
				],
				corrections: [
					{ turn: 1, text: "actually, always run pnpm typecheck" },
				],
			},
			chunks: [],
		});
		await extractFromSession(repoKey, "s-1");

		const idx = openMemoryIndex(repoKey);
		const row = idx
			.rawDb()
			.prepare("SELECT id, re_extract_count FROM memories LIMIT 1")
			.get() as { id: string; re_extract_count: number };
		idx.close();
		expect(row.re_extract_count).toBe(0);
	}, 60_000);

	it("increments to 1 when a dedup-collapsed candidate arrives in a second session", async () => {
		await writeSession(repoKey, {
			version: 2,
			id: "s-1",
			startedAt: "2026-04-30T00:00:00Z",
			endedAt: null,
			turnCount: 1,
			lastProcessedTurn: 1,
			hasSummary: false,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: "/tmp/x",
			summary: "",
			evidence: {
				toolCalls: [],
				filePaths: [],
				userPrompts: [
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before commit",
					},
				],
				corrections: [
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before commit",
					},
				],
			},
			chunks: [],
		});
		await extractFromSession(repoKey, "s-1");

		await writeSession(repoKey, {
			version: 2,
			id: "s-2",
			startedAt: "2026-04-30T02:00:00Z",
			endedAt: null,
			turnCount: 1,
			lastProcessedTurn: 1,
			hasSummary: false,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: "/tmp/y",
			summary: "",
			evidence: {
				toolCalls: [],
				filePaths: [],
				userPrompts: [
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before pushing",
					},
				],
				corrections: [
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before pushing",
					},
				],
			},
			chunks: [],
		});
		const r = await extractFromSession(repoKey, "s-2");
		expect(r.evidenceAppended).toBe(1); // dedup hit

		const idx = openMemoryIndex(repoKey);
		const row = idx
			.rawDb()
			.prepare("SELECT re_extract_count FROM memories LIMIT 1")
			.get() as { re_extract_count: number };
		idx.close();
		expect(row.re_extract_count).toBe(1);
	}, 60_000);
});
