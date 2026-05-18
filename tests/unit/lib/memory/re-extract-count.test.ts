import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import type {
	SessionRecord,
	UserPromptEvidence,
} from "../../../../src/lib/history/types.js";

// Translated: extracted captures no longer carry a re_extract promotion. A
// dedup hit appends provenance only — it does NOT call bumpReExtract, so
// re_extract_count stays 0 across re-extraction (the agent, not the
// extractor, judges durability).

function sess(id: string, userPrompts: UserPromptEvidence[]): SessionRecord {
	const maxTurn = userPrompts.reduce((m, u) => Math.max(m, u.turn), 0);
	return {
		version: 2,
		id,
		startedAt: "2026-04-30T00:00:00Z",
		endedAt: null,
		turnCount: maxTurn,
		lastProcessedTurn: maxTurn,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/tmp/x",
		summary: "",
		evidence: {
			toolCalls: [],
			filePaths: [],
			userPrompts,
			corrections: [],
		},
		chunks: [],
	};
}

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("re-extract-count");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

describe("reExtractCount", () => {
	it("starts at 0 for a fresh candidate", async () => {
		await writeSession(
			repoKey,
			sess("s-1", [
				{
					turn: 1,
					text: "actually, always run pnpm typecheck before every commit",
				},
			]),
		);
		await extractFromSession(repoKey, "s-1");

		const idx = openMemoryIndex(repoKey);
		const row = idx
			.rawDb()
			.prepare("SELECT id, re_extract_count FROM memories LIMIT 1")
			.get() as { id: string; re_extract_count: number };
		idx.close();
		expect(row.re_extract_count).toBe(0);
	}, 60_000);

	it("stays at 0 when a dedup-collapsed capture arrives in a second session (no extracted promotion)", async () => {
		await writeSession(
			repoKey,
			sess("s-1", [
				{
					turn: 1,
					text: "actually, always run pnpm typecheck before committing changes",
				},
			]),
		);
		await extractFromSession(repoKey, "s-1");

		await writeSession(
			repoKey,
			sess("s-2", [
				{
					turn: 1,
					text: "actually, always run pnpm typecheck before pushing changes",
				},
			]),
		);
		const r = await extractFromSession(repoKey, "s-2");
		expect(r.evidenceAppended).toBe(1); // dedup hit

		const idx = openMemoryIndex(repoKey);
		const row = idx
			.rawDb()
			.prepare("SELECT re_extract_count FROM memories LIMIT 1")
			.get() as { re_extract_count: number };
		idx.close();
		expect(row.re_extract_count).toBe(0);
	}, 60_000);
});
