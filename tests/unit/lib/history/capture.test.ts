import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSession } from "../../../../src/lib/history/capture.js";
import { readSession, listSessions, readAllChunks, acquireLock, readChunkVectors } from "../../../../src/lib/history/store.js";
import { MODEL_NAME } from "../../../../src/lib/embed-provider.js";

const FIXTURE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"fixtures",
	"history",
	"sample.jsonl",
);

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-cap-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("captureSession", () => {
	it("creates a session record from the fixture transcript", async () => {
		const result = await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		expect(result).toEqual({ status: "captured", turnsProcessed: 8 });
		const rec = readSession("REPO", "s1");
		expect(rec).not.toBeNull();
		expect(rec!.turnCount).toBe(8);
		expect(rec!.lastProcessedTurn).toBe(7);
		expect(rec!.evidence.userPrompts.length).toBeGreaterThan(0);
		expect(rec!.summary).toContain("Looked at foo.ts");
	});

	it("running twice on the same transcript is a no-op (idempotent)", async () => {
		await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		const before = JSON.stringify(readSession("REPO", "s1"));
		const second = await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		expect(second.status).toBe("up-to-date");
		const after = JSON.stringify(readSession("REPO", "s1"));
		expect(after).toBe(before);
	});

	it("writes chunk text to chunks.jsonl", async () => {
		await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		const chunks = readAllChunks("REPO", "s1");
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("skips when lock is held by a live process", async () => {
		acquireLock("REPO", "s1");
		const result = await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		expect(result.status).toBe("skipped-locked");
		expect(listSessions("REPO")).toEqual([]);
	});

	it("returns 'disabled' status and writes nothing when history is disabled", async () => {
		process.env.AI_CORTEX_HISTORY = "0";
		try {
			const result = await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
			expect(result.status).toBe("disabled");
			expect(listSessions("REPO")).toEqual([]);
		} finally {
			delete process.env.AI_CORTEX_HISTORY;
		}
	});

	it("re-runs when chunks.jsonl is missing despite lastProcessedTurn match (crash-resume)", async () => {
		await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		// Simulate crash that left session.json but lost chunks.jsonl
		fs.unlinkSync(path.join(tmp, ".cache", "ai-cortex", "v1", "REPO", "history", "sessions", "s1", "chunks.jsonl"));
		const second = await captureSession({ repoKey: "REPO", sessionId: "s1", transcriptPath: FIXTURE, embed: false });
		expect(second.status).toBe("captured"); // not "up-to-date" — completeness check forces re-run
		expect(readAllChunks("REPO", "s1").length).toBeGreaterThan(0);
	});
});

describe("captureSession with embed:true", () => {
	// First call downloads ~23 MB model — give it room.
	it("writes vector index for chunks", { timeout: 120_000 }, async () => {
		const result = await captureSession({ repoKey: "REPO", sessionId: "se", transcriptPath: FIXTURE, embed: true });
		expect(result.status).toBe("captured");
		const vecs = readChunkVectors("REPO", "se", MODEL_NAME);
		expect(vecs).not.toBeNull();
		expect(vecs!.byChunkId.size).toBeGreaterThan(0);
		expect(vecs!.dim).toBe(384);
	});
});
