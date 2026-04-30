import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { producePatternCandidates } from "../../../../src/lib/memory/extract.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

function mkSession(id: string, files: string[], prompts: string[]): SessionRecord {
	return {
		version: 2,
		id,
		startedAt: "2026-04-01T00:00:00Z",
		endedAt: "2026-04-01T01:00:00Z",
		turnCount: 1,
		lastProcessedTurn: 0,
		hasSummary: true,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/tmp/x",
		summary: prompts.join(" "),
		evidence: {
			toolCalls: [],
			filePaths: files.map((path, i) => ({ turn: i, path })),
			userPrompts: prompts.map((text, i) => ({ turn: i, text })),
			corrections: [],
		},
		chunks: [],
	};
}

describe("producePatternCandidates", () => {
	let repoKey: string;
	beforeEach(async () => { repoKey = await mkRepoKey("pattern"); });
	afterEach(async () => { await cleanupRepo(repoKey); });

	it("emits a pattern when ≥3 sessions share a file set with similar prompts", async () => {
		const files = ["src/cache-store.ts", "src/lib/memory/store.ts"];
		const prompts = ["how do I add atomic write to the cache layer"];
		await writeSession(repoKey, mkSession("s-a", files, prompts));
		await writeSession(repoKey, mkSession("s-b", files, ["atomic writes for cache files"]));
		const target = mkSession("s-c", files, ["atomic write helper for cache layer"]);
		await writeSession(repoKey, target);

		const out = await producePatternCandidates(repoKey, "s-c", target);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("pattern");
		expect(out[0].confidence).toBeCloseTo(0.35, 2);
		expect(out[0].scopeFiles).toEqual(expect.arrayContaining(files));
	});

	it("emits nothing when only 2 sessions share the file set", async () => {
		const files = ["src/x.ts", "src/y.ts"];
		await writeSession(repoKey, mkSession("s-a", files, ["work on x"]));
		const target = mkSession("s-b", files, ["work on x again"]);
		await writeSession(repoKey, target);
		const out = await producePatternCandidates(repoKey, "s-b", target);
		expect(out).toEqual([]);
	});
});
