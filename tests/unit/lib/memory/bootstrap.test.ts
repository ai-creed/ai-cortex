import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapFromHistory } from "../../../../src/lib/memory/bootstrap.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

function mkSession(
	id: string,
	correction: string,
	startedAt = "2026-04-30T00:00:00Z",
): SessionRecord {
	return {
		version: 2,
		id,
		startedAt,
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
			filePaths: [{ turn: 4, path: "src/x.ts" }],
			userPrompts: [],
			corrections: [{ turn: 4, text: correction }],
		},
		chunks: [],
	};
}

describe("bootstrapFromHistory", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("bootstrap");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("processes every session and reports aggregate counts", async () => {
		await writeSession(
			repoKey,
			mkSession("s-1", "always run pnpm typecheck before commit"),
		);
		await writeSession(
			repoKey,
			mkSession("s-2", "never disable hooks during commit"),
		);

		const r = await bootstrapFromHistory(repoKey);
		expect(r.sessionsProcessed).toBe(2);
		expect(r.candidatesCreated).toBeGreaterThanOrEqual(2);

		const idx = openMemoryIndex(repoKey);
		const count = (
			idx.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as any
		).c;
		idx.close();
		expect(count).toBeGreaterThanOrEqual(2);
	});

	it("respects --limit-sessions and selects the oldest sessions chronologically", async () => {
		await writeSession(
			repoKey,
			mkSession("s-newest", "always run format", "2026-04-03T00:00:00Z"),
		);
		await writeSession(
			repoKey,
			mkSession("s-oldest", "always run typecheck", "2026-04-01T00:00:00Z"),
		);
		await writeSession(
			repoKey,
			mkSession("s-middle", "always run lint", "2026-04-02T00:00:00Z"),
		);

		const r = await bootstrapFromHistory(repoKey, { limitSessions: 2 });
		expect(r.sessionsProcessed).toBe(2);
		const picked = r.perSession.map((p) => p.sessionId);
		expect(picked).toEqual(["s-oldest", "s-middle"]);
	});

	it("is idempotent on re-run (no duplicate memories)", async () => {
		await writeSession(repoKey, mkSession("s-1", "always run pnpm typecheck"));
		await bootstrapFromHistory(repoKey);
		const idx1 = openMemoryIndex(repoKey);
		const before = (
			idx1.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as any
		).c;
		idx1.close();

		await bootstrapFromHistory(repoKey, { allowReExtract: true });
		const idx2 = openMemoryIndex(repoKey);
		const after = (
			idx2.rawDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as any
		).c;
		idx2.close();

		expect(after).toBe(before);
	});

	it("respects --min-confidence", async () => {
		await writeSession(repoKey, mkSession("s-1", "actually use foo"));
		const r = await bootstrapFromHistory(repoKey, { minConfidence: 0.99 });
		expect(r.candidatesCreated).toBe(0);
	});
});
