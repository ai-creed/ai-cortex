import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSession } from "../../../../src/lib/history/capture.js";
import {
	readSession,
	listSessions,
	readAllChunks,
	acquireLock,
	readChunkVectors,
} from "../../../../src/lib/history/store.js";
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
let savedCacheHome: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-cap-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	// The global vitest setup pins AI_CORTEX_CACHE_HOME to a session-shared
	// tmpdir; this file reuses hardcoded repo/session keys (and one test
	// computes a tmp/.cache/ai-cortex/v1/... path directly). Pin the cache
	// home to this test's tmp so the homedir-relative layout still holds and
	// prior tests' writes don't leak in.
	savedCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	process.env.AI_CORTEX_CACHE_HOME = path.join(
		tmp,
		".cache",
		"ai-cortex",
		"v1",
	);
});

afterEach(() => {
	if (savedCacheHome !== undefined)
		process.env.AI_CORTEX_CACHE_HOME = savedCacheHome;
	else delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("captureSession", () => {
	it("creates a session record from the fixture transcript", async () => {
		const result = await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		expect(result).toEqual({ status: "captured", turnsProcessed: 8 });
		const rec = await readSession("aabbccdd00112233", "s1");
		expect(rec).not.toBeNull();
		expect(rec!.turnCount).toBe(8);
		expect(rec!.lastProcessedTurn).toBe(7);
		expect(rec!.evidence.userPrompts.length).toBeGreaterThan(0);
		expect(rec!.summary).toContain("Looked at foo.ts");
	});

	it("running twice on the same transcript is a no-op (idempotent)", async () => {
		await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		const before = JSON.stringify(await readSession("aabbccdd00112233", "s1"));
		const second = await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		expect(second.status).toBe("up-to-date");
		const after = JSON.stringify(await readSession("aabbccdd00112233", "s1"));
		expect(after).toBe(before);
	});

	it("writes chunk text to chunks.jsonl", async () => {
		await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		const chunks = await readAllChunks("aabbccdd00112233", "s1");
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("skips when lock is held by a live process", async () => {
		await acquireLock("aabbccdd00112233", "s1");
		const result = await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		expect(result.status).toBe("skipped-locked");
		expect(await listSessions("aabbccdd00112233")).toEqual([]);
	});

	it("returns 'disabled' status and writes nothing when history is disabled", async () => {
		process.env.AI_CORTEX_HISTORY = "0";
		try {
			const result = await captureSession({
				repoKey: "aabbccdd00112233",
				sessionId: "s1",
				transcriptPath: FIXTURE,
				embed: false,
			});
			expect(result.status).toBe("disabled");
			expect(await listSessions("aabbccdd00112233")).toEqual([]);
		} finally {
			delete process.env.AI_CORTEX_HISTORY;
		}
	});

	it("re-runs when chunks.jsonl is missing despite lastProcessedTurn match (crash-resume)", async () => {
		await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		// Simulate crash that left session.json but lost chunks.jsonl
		fs.unlinkSync(
			path.join(
				tmp,
				".cache",
				"ai-cortex",
				"v1",
				"aabbccdd00112233",
				"history",
				"sessions",
				"s1",
				"chunks.jsonl",
			),
		);
		const second = await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "s1",
			transcriptPath: FIXTURE,
			embed: false,
		});
		expect(second.status).toBe("captured"); // not "up-to-date" — completeness check forces re-run
		expect((await readAllChunks("aabbccdd00112233", "s1")).length).toBeGreaterThan(0);
	});

	it("persists worktreePath on capture and preserves it on later captures without one", async () => {
		const repoKey = "aabbccdd00112233";
		const transcriptPath = path.join(tmp, "origin.jsonl");
		fs.copyFileSync(FIXTURE, transcriptPath);
		// Same content plus one appended turn, for the re-capture below — a
		// legacy caller that omits worktreePath must not erase the recorded origin.
		const transcriptPathWithExtraTurn = path.join(tmp, "origin-extra.jsonl");
		fs.writeFileSync(
			transcriptPathWithExtraTurn,
			fs.readFileSync(FIXTURE, "utf8") +
				JSON.stringify({
					type: "user",
					turn: 8,
					message: { content: [{ type: "text", text: "one more turn" }] },
				}) +
				"\n",
		);

		const first = await captureSession({
			repoKey,
			sessionId: "s-origin",
			transcriptPath,
			embed: false,
			worktreePath: "/tmp/smoke-ws",
		});
		expect(first.status).toBe("captured");
		expect((await readSession(repoKey, "s-origin"))!.worktreePath).toBe(
			"/tmp/smoke-ws",
		);

		// re-capture without the field (legacy caller): origin must survive
		const again = await captureSession({
			repoKey,
			sessionId: "s-origin",
			transcriptPath: transcriptPathWithExtraTurn,
			embed: false,
		});
		expect(again.status).toBe("captured");
		expect((await readSession(repoKey, "s-origin"))!.worktreePath).toBe(
			"/tmp/smoke-ws",
		);
	});
});

describe("captureSession with embed:true", () => {
	// First call downloads ~23 MB model — give it room.
	it("writes vector index for chunks", { timeout: 120_000 }, async () => {
		const result = await captureSession({
			repoKey: "aabbccdd00112233",
			sessionId: "se",
			transcriptPath: FIXTURE,
			embed: true,
		});
		expect(result.status).toBe("captured");
		const vecs = await readChunkVectors("aabbccdd00112233", "se", MODEL_NAME);
		expect(vecs).not.toBeNull();
		expect(vecs!.byChunkId.size).toBeGreaterThan(0);
		expect(vecs!.dim).toBe(384);
	});
});
