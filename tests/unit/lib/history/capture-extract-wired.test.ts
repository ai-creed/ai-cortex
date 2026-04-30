import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { captureSession } from "../../../../src/lib/history/capture.js";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import { extractorRunPath } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

// vi.mock at module top — ESM bindings are read-only so namespace mutation doesn't work
vi.mock("../../../../src/lib/memory/extract.js", () => ({
	extractFromSession: vi.fn(),
}));

const TRANSCRIPT_LINES = [
	{ type: "user", turn: 1, message: { content: "always use POST for create endpoints" } },
	{ type: "assistant", turn: 2, message: { content: "Got it — using POST." } },
];

async function writeFakeTranscript(p: string): Promise<void> {
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("captureSession — extractor wiring", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("cap-extract");
		vi.mocked(extractFromSession).mockReset();
		vi.mocked(extractFromSession).mockResolvedValue({
			version: 1,
			sessionId: "stub",
			runAt: "2026-04-30T00:00:00Z",
			lastProcessedTurn: 0,
			candidatesCreated: 0,
			evidenceAppended: 0,
			rejectedCandidates: [],
			createdMemoryIds: [],
			appendedToMemoryIds: [],
		});
	});
	afterEach(async () => { await cleanupRepo(repoKey); });

	it("captureSession invokes extractor after compaction", async () => {
		const tp = path.join("/tmp", `aicortex-test-transcript-${Date.now()}.jsonl`);
		await writeFakeTranscript(tp);
		const r = await captureSession({ repoKey, sessionId: "s-cap-1", transcriptPath: tp, embed: false });
		expect(r.status).toBe("captured");
		expect(vi.mocked(extractFromSession)).toHaveBeenCalledWith(repoKey, "s-cap-1");
	});

	it("does not fail capture if the extractor throws", async () => {
		const tp = path.join("/tmp", `aicortex-test-transcript-${Date.now()}-2.jsonl`);
		await writeFakeTranscript(tp);
		vi.mocked(extractFromSession).mockRejectedValueOnce(new Error("boom"));
		const r = await captureSession({ repoKey, sessionId: "s-cap-2", transcriptPath: tp, embed: false });
		expect(r.status).toBe("captured");
	});
});
