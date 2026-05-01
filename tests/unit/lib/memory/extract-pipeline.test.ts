import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("extractFromSession — end to end", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("extract-e2e");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("creates a candidate for an imperative correction", async () => {
		await writeSession(repoKey, {
			version: 2,
			id: "s-1",
			startedAt: "2026-04-30T00:00:00Z",
			endedAt: "2026-04-30T01:00:00Z",
			turnCount: 4,
			lastProcessedTurn: 4,
			hasSummary: false,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: "/tmp/x",
			summary: "",
			evidence: {
				toolCalls: [],
				filePaths: [{ turn: 5, path: "src/api/create.ts" }],
				userPrompts: [
					{
						turn: 4,
						text: "actually, you must always use POST for create endpoints",
						nextAssistantSnippet: "Got it — switching to POST.",
					},
				],
				corrections: [
					{
						turn: 4,
						text: "actually, you must always use POST for create endpoints",
						nextAssistantSnippet: "Got it — switching to POST.",
					},
				],
			},
			chunks: [],
		});

		const r = await extractFromSession(repoKey, "s-1");
		expect(r.candidatesCreated).toBe(1);
		expect(r.evidenceAppended).toBe(0);

		const idx = openMemoryIndex(repoKey);
		const rows = idx
			.rawDb()
			.prepare("SELECT id, type, status, confidence FROM memories")
			.all();
		expect(rows).toHaveLength(1);
		expect((rows[0] as any).type).toBe("decision");
		expect((rows[0] as any).status).toBe("candidate");
		expect((rows[0] as any).confidence).toBeCloseTo(0.55, 2);
		idx.close();
	}, 60_000);

	it("appends evidence and bumps confidence on a near-duplicate in a second session", async () => {
		await writeSession(repoKey, {
			version: 2,
			id: "s-1",
			startedAt: "2026-04-30T00:00:00Z",
			endedAt: "2026-04-30T01:00:00Z",
			turnCount: 1,
			lastProcessedTurn: 1,
			hasSummary: false,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: "/tmp/x",
			summary: "",
			evidence: {
				toolCalls: [],
				filePaths: [{ turn: 4, path: "src/api/create.ts" }],
				userPrompts: [
					{ turn: 4, text: "actually, always use POST for create endpoints" },
				],
				corrections: [
					{ turn: 4, text: "actually, always use POST for create endpoints" },
				],
			},
			chunks: [],
		});
		await extractFromSession(repoKey, "s-1");

		await writeSession(repoKey, {
			version: 2,
			id: "s-2",
			startedAt: "2026-04-30T02:00:00Z",
			endedAt: "2026-04-30T03:00:00Z",
			turnCount: 1,
			lastProcessedTurn: 1,
			hasSummary: false,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: "/tmp/y",
			summary: "",
			evidence: {
				toolCalls: [],
				filePaths: [{ turn: 2, path: "src/api/update.ts" }],
				userPrompts: [
					{
						turn: 2,
						text: "actually, always prefer POST for create endpoints",
					},
				],
				corrections: [
					{
						turn: 2,
						text: "actually, always prefer POST for create endpoints",
					},
				],
			},
			chunks: [],
		});
		const r = await extractFromSession(repoKey, "s-2");
		expect(r.candidatesCreated).toBe(0);
		expect(r.evidenceAppended).toBe(1);

		const idx = openMemoryIndex(repoKey);
		const rows = idx
			.rawDb()
			.prepare("SELECT id, confidence FROM memories")
			.all() as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].confidence).toBeCloseTo(0.55, 2); // 0.45 + 0.10 bump
		idx.close();
	}, 60_000);

	it("re-running on a session that has not grown is a no-op (lastProcessedTurn covers all turns)", async () => {
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
		const r1 = await extractFromSession(repoKey, "s-1");
		expect(r1.candidatesCreated).toBe(1);
		expect(r1.lastProcessedTurn).toBe(1);

		const r2 = await extractFromSession(repoKey, "s-1");
		expect(r2.candidatesCreated).toBe(0);
		expect(r2.evidenceAppended).toBe(0);
		expect(r2.lastProcessedTurn).toBe(1);

		const idx = openMemoryIndex(repoKey);
		const count = (
			idx.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as any
		).c;
		idx.close();
		expect(count).toBe(1);
	}, 60_000);

	it("re-running after session grows extracts only the new turns", async () => {
		await writeSession(repoKey, {
			version: 2,
			id: "s-1",
			startedAt: "2026-04-30T00:00:00Z",
			endedAt: null,
			turnCount: 2,
			lastProcessedTurn: 2,
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
		const r1 = await extractFromSession(repoKey, "s-1");
		expect(r1.candidatesCreated).toBe(1);
		expect(r1.lastProcessedTurn).toBe(1);

		await writeSession(repoKey, {
			version: 2,
			id: "s-1",
			startedAt: "2026-04-30T00:00:00Z",
			endedAt: null,
			turnCount: 6,
			lastProcessedTurn: 6,
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
					{ turn: 5, text: "actually, never disable hooks during commit" },
				],
				corrections: [
					{ turn: 1, text: "actually, always run pnpm typecheck" },
					{ turn: 5, text: "actually, never disable hooks during commit" },
				],
			},
			chunks: [],
		});
		const r2 = await extractFromSession(repoKey, "s-1");
		expect(r2.candidatesCreated + r2.evidenceAppended).toBe(1);
		expect(r2.lastProcessedTurn).toBe(5);

		const idx = openMemoryIndex(repoKey);
		const count = (
			idx.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as any
		).c;
		idx.close();
		expect(count).toBe(2);
	}, 60_000);

	it("allowReExtract: true re-scans from turn 0 and overwrites the manifest", async () => {
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
		const r = await extractFromSession(repoKey, "s-1", {
			allowReExtract: true,
		});
		expect(r.evidenceAppended + r.candidatesCreated).toBeGreaterThanOrEqual(1);
		expect(r.lastProcessedTurn).toBe(1);
	}, 60_000);
});
