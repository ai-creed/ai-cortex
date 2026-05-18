import { describe, it, expect, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openLifecycle } from "../../../../src/lib/memory/lifecycle.js";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import type {
	SessionRecord,
	UserPromptEvidence,
} from "../../../../src/lib/history/types.js";

// `sess(id, userPrompts)` mirrors the exact SessionRecord literal the existing
// extract-*.test.ts files pass to writeSession, with the given userPrompts and
// empty corrections/toolCalls/filePaths.
function sess(id: string, userPrompts: UserPromptEvidence[]): SessionRecord {
	return {
		version: 2,
		id,
		startedAt: "2026-04-30T00:00:00Z",
		endedAt: "2026-04-30T01:00:00Z",
		turnCount: userPrompts.length,
		lastProcessedTurn: userPrompts.length,
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

describe("extractFromSession with structural gate", () => {
	let repoKey: string;
	afterEach(async () => {
		if (repoKey) await cleanupRepo(repoKey);
	});

	it("creates only structurally-clean survivors, all type:capture status:candidate", async () => {
		repoKey = await mkRepoKey("extract-gate-1");
		await writeSession(
			repoKey,
			sess("s1", [
				{ turn: 1, text: "ok", nextAssistantSnippet: "Sure." },
				{
					turn: 2,
					text: "too dimmed, should be lighter",
					nextAssistantSnippet: "Done.",
				},
				{
					turn: 3,
					text: "CLAUDE_SESSION_ID is too specific to claude. Make it agnostic; Codex sends one too.",
					nextAssistantSnippet: "Agreed, generalizing.",
				},
			]),
		);
		const lc = await openLifecycle(repoKey);
		try {
			await extractFromSession(repoKey, "s1");
			const rows = lc.index
				.rawDb()
				.prepare("SELECT type,status,source FROM memories")
				.all() as { type: string; status: string; source: string }[];
			expect(rows).toHaveLength(1); // turns 1+2 rejected, turn 3 survives
			expect(rows[0]).toEqual({
				type: "capture",
				status: "candidate",
				source: "extracted",
			});
		} finally {
			lc.close();
		}
	}, 60_000);

	it("dedup hit appends provenance only — no confidence/re_extract bump", async () => {
		repoKey = await mkRepoKey("extract-gate-2");
		const body =
			"CLAUDE_SESSION_ID is too specific to claude. Make it agnostic; Codex sends one too.";
		await writeSession(
			repoKey,
			sess("s1", [{ turn: 1, text: body, nextAssistantSnippet: "ok" }]),
		);
		await writeSession(
			repoKey,
			sess("s2", [{ turn: 1, text: body, nextAssistantSnippet: "ok" }]),
		);
		const lc = await openLifecycle(repoKey);
		try {
			await extractFromSession(repoKey, "s1");
			const before = lc.index
				.rawDb()
				.prepare("SELECT id,confidence,re_extract_count FROM memories")
				.get() as {
				id: string;
				confidence: number;
				re_extract_count: number;
			};
			await extractFromSession(repoKey, "s2"); // dedup hit
			const after = lc.index
				.rawDb()
				.prepare(
					"SELECT confidence,re_extract_count FROM memories WHERE id=?",
				)
				.get(before.id) as {
				confidence: number;
				re_extract_count: number;
			};
			expect(after.confidence).toBe(before.confidence);
			expect(after.re_extract_count).toBe(before.re_extract_count);
			const n = lc.index
				.rawDb()
				.prepare("SELECT count(*) c FROM memories")
				.get() as { c: number };
			expect(n.c).toBe(1); // no second row
		} finally {
			lc.close();
		}
	}, 60_000);
});
