import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import type {
	SessionRecord,
	UserPromptEvidence,
} from "../../../../src/lib/history/types.js";

// Translated from the old positive-classifier contract. Post structural-gate
// rewrite: every clean user turn → one `type:"capture"` `status:"candidate"`
// `source:"extracted"` memory; no decision/gotcha/how-to typing at extract
// time; dedup hits append provenance only with NO confidence/re_extract
// promotion; structural rejection happens in the gate (no minConfidence floor,
// no rejectedCandidates bookkeeping for floor/short-body).

function sess(
	id: string,
	userPrompts: UserPromptEvidence[],
	overrides: Partial<SessionRecord> = {},
): SessionRecord {
	const maxTurn = userPrompts.reduce((m, u) => Math.max(m, u.turn), 0);
	return {
		version: 2,
		id,
		startedAt: "2026-04-30T00:00:00Z",
		endedAt: "2026-04-30T01:00:00Z",
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
		...overrides,
	};
}

describe("extractFromSession — end to end (structural gate)", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("extract-e2e");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("creates one type:capture candidate for a structurally-clean turn", async () => {
		await writeSession(repoKey, {
			...sess("s-1", [
				{
					turn: 4,
					text: "actually, you must always use POST for create endpoints, never GET",
					nextAssistantSnippet: "Got it — switching to POST.",
				},
			]),
			evidence: {
				toolCalls: [],
				filePaths: [{ turn: 5, path: "src/api/create.ts" }],
				userPrompts: [
					{
						turn: 4,
						text: "actually, you must always use POST for create endpoints, never GET",
						nextAssistantSnippet: "Got it — switching to POST.",
					},
				],
				corrections: [],
			},
		});

		const r = await extractFromSession(repoKey, "s-1");
		expect(r.candidatesCreated).toBe(1);
		expect(r.evidenceAppended).toBe(0);

		const idx = openMemoryIndex(repoKey);
		const rows = idx
			.rawDb()
			.prepare("SELECT id, type, status, source FROM memories")
			.all() as { id: string; type: string; status: string; source: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe("capture");
		expect(rows[0].status).toBe("candidate");
		expect(rows[0].source).toBe("extracted");
		idx.close();
	}, 60_000);

	it("dedup hit in a second session appends provenance only — no confidence/re_extract bump", async () => {
		await writeSession(
			repoKey,
			sess("s-1", [
				{
					turn: 4,
					text: "actually, always use POST for create endpoints and never GET them",
				},
			]),
		);
		await extractFromSession(repoKey, "s-1");

		const idx0 = openMemoryIndex(repoKey);
		const before = idx0
			.rawDb()
			.prepare("SELECT id, confidence, re_extract_count FROM memories")
			.get() as { id: string; confidence: number; re_extract_count: number };
		idx0.close();

		await writeSession(
			repoKey,
			sess("s-2", [
				{
					turn: 2,
					text: "actually, always use POST for create endpoints and never GET them",
				},
			]),
		);
		const r = await extractFromSession(repoKey, "s-2");
		expect(r.candidatesCreated).toBe(0);
		expect(r.evidenceAppended).toBe(1);

		const idx = openMemoryIndex(repoKey);
		const rows = idx
			.rawDb()
			.prepare("SELECT id, confidence, re_extract_count FROM memories")
			.all() as {
			id: string;
			confidence: number;
			re_extract_count: number;
		}[];
		idx.close();
		expect(rows).toHaveLength(1);
		expect(rows[0].confidence).toBe(before.confidence);
		expect(rows[0].re_extract_count).toBe(before.re_extract_count);
	}, 60_000);

	it("re-running on a session that has not grown is a no-op", async () => {
		await writeSession(
			repoKey,
			sess(
				"s-1",
				[
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before every commit",
					},
				],
				{ endedAt: null },
			),
		);
		const r1 = await extractFromSession(repoKey, "s-1");
		expect(r1.candidatesCreated).toBe(1);
		expect(r1.lastProcessedTurn).toBe(1);

		const r2 = await extractFromSession(repoKey, "s-1");
		expect(r2.candidatesCreated).toBe(0);
		expect(r2.evidenceAppended).toBe(0);
		expect(r2.lastProcessedTurn).toBe(1);

		const idx = openMemoryIndex(repoKey);
		const count = (
			idx.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as {
				c: number;
			}
		).c;
		idx.close();
		expect(count).toBe(1);
	}, 60_000);

	it("re-running after the session grows extracts only the new turns", async () => {
		await writeSession(
			repoKey,
			sess(
				"s-1",
				[
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before every commit",
					},
				],
				{ endedAt: null },
			),
		);
		const r1 = await extractFromSession(repoKey, "s-1");
		expect(r1.candidatesCreated).toBe(1);
		expect(r1.lastProcessedTurn).toBe(1);

		await writeSession(
			repoKey,
			sess(
				"s-1",
				[
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before every commit",
					},
					{
						turn: 5,
						text: "actually, never disable git hooks during a commit operation",
					},
				],
				{ endedAt: null },
			),
		);
		const r2 = await extractFromSession(repoKey, "s-1");
		expect(r2.candidatesCreated + r2.evidenceAppended).toBe(1);
		expect(r2.lastProcessedTurn).toBe(5);

		const idx = openMemoryIndex(repoKey);
		const count = (
			idx.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as {
				c: number;
			}
		).c;
		idx.close();
		expect(count).toBe(2);
	}, 60_000);

	it("the structural gate rejects short throwaway turns (filler rule, <25 chars)", async () => {
		await writeSession(
			repoKey,
			sess("s-short", [{ turn: 1, text: "we should ship" }]),
		);
		const r = await extractFromSession(repoKey, "s-short");
		expect(r.candidatesCreated).toBe(0);

		const idx = openMemoryIndex(repoKey);
		const count = (
			idx.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as {
				c: number;
			}
		).c;
		idx.close();
		expect(count).toBe(0);
	}, 60_000);

	it("the gate uniformly rejects short bodies regardless of an assistant ack", async () => {
		await writeSession(
			repoKey,
			sess("s-short-ack", [
				{ turn: 1, text: "always use rg", nextAssistantSnippet: "Got it" },
			]),
		);
		// Old contract accepted this via an ack confidence boost; the structural
		// gate has no boost concept — short bodies (<25 chars) are filler.
		const r = await extractFromSession(repoKey, "s-short-ack");
		expect(r.candidatesCreated).toBe(0);
	}, 60_000);

	it("filters harness-injected pseudo-prompts from evidence at extract time", async () => {
		await writeSession(
			repoKey,
			sess("s-harness", [
				{
					turn: 1,
					text: "Base directory for this skill: /Users/x/.claude/skills/foo\n\n# Foo\n\nMUST always do bar",
				},
				{
					turn: 2,
					text: "<system-reminder>\nMUST follow this rule\n</system-reminder>",
				},
			]),
		);
		const r = await extractFromSession(repoKey, "s-harness");
		expect(r.candidatesCreated).toBe(0);
	}, 60_000);

	it("allowReExtract: true re-scans from turn 0 and overwrites the manifest", async () => {
		await writeSession(
			repoKey,
			sess(
				"s-1",
				[
					{
						turn: 1,
						text: "actually, always run pnpm typecheck before every commit",
					},
				],
				{ endedAt: null },
			),
		);
		await extractFromSession(repoKey, "s-1");
		const r = await extractFromSession(repoKey, "s-1", {
			allowReExtract: true,
		});
		expect(r.evidenceAppended + r.candidatesCreated).toBeGreaterThanOrEqual(1);
		expect(r.lastProcessedTurn).toBe(1);
	}, 60_000);
});
