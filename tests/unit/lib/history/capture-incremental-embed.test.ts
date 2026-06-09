import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Record every text array passed to provider.embed so the test can assert
// which chunks get an embedding round-trip on each capture. Hoisted so the
// vi.mock factory (which vitest lifts to the top of the module) can close
// over it; a per-file mock wins over the global setupFiles mock.
const { embedCalls, fakeVec } = vi.hoisted(() => {
	const embedCalls: string[][] = [];
	function fakeVec(text: string): Float32Array {
		const v = new Float32Array(384);
		let h = 0;
		for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
		v[h % 384] = 1; // unit vector → already L2-normalized
		return v;
	}
	return { embedCalls, fakeVec };
});

vi.mock("../../../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(async () => ({
		embed: async (texts: string[]) => {
			embedCalls.push(texts);
			return texts.map(fakeVec);
		},
	})),
}));

// The best-effort memory extractor also calls provider.embed for its memory
// candidates; stub it so `embedCalls` reflects only the capture path's chunk
// embedding (the extractor has its own tests).
vi.mock("../../../../src/lib/memory/extract.js", () => ({
	extractFromSession: vi.fn(async () => {}),
}));

import { captureSession } from "../../../../src/lib/history/capture.js";
import {
	readAllChunks,
	readChunkVectors,
} from "../../../../src/lib/history/store.js";
import { MODEL_NAME } from "../../../../src/lib/embed-provider.js";

const REPO = "aabbccdd00112233";
const SESSION = "inc";

let tmp: string;
let savedCacheHome: string | undefined;

beforeEach(() => {
	embedCalls.length = 0;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-inc-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	savedCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	process.env.AI_CORTEX_CACHE_HOME = path.join(tmp, ".cache", "ai-cortex", "v1");
});

afterEach(() => {
	if (savedCacheHome !== undefined)
		process.env.AI_CORTEX_CACHE_HOME = savedCacheHome;
	else delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

// Each word is unique so chunk boundaries produce distinct chunk text — this
// makes "unchanged chunk" assertions unambiguous (no accidental hash collisions
// between two chunks that happen to share filler words).
function words(prefix: string, n: number): string {
	return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

function writeTranscript(
	file: string,
	turns: { role: "user" | "assistant"; turn: number; text: string }[],
): void {
	const lines = turns.map((t) =>
		JSON.stringify({
			type: t.role,
			turn: t.turn,
			message: { content: [{ type: "text", text: t.text }] },
		}),
	);
	fs.writeFileSync(file, lines.join("\n") + "\n");
}

describe("captureSession incremental embedding", () => {
	it("does not re-embed chunks whose text is unchanged when new turns append", async () => {
		const file = path.join(tmp, "transcript.jsonl");
		// ~1100 tokens → three 512-token chunks (chunk 2 is a partial tail).
		writeTranscript(file, [{ role: "user", turn: 0, text: words("a", 1100) }]);

		await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});

		const firstEmbedded = embedCalls.flat();
		const totalChunks = (await readAllChunks(REPO, SESSION)).length;
		expect(totalChunks).toBeGreaterThanOrEqual(3);
		expect(firstEmbedded).toHaveLength(totalChunks); // first capture embeds all

		const unchangedChunk0 = firstEmbedded[0];
		const unchangedChunk1 = firstEmbedded[1];

		// Append a turn that only adds tokens at the tail: leading full chunks
		// keep byte-identical text, only the partial tail chunk changes.
		embedCalls.length = 0;
		writeTranscript(file, [
			{ role: "user", turn: 0, text: words("a", 1100) },
			{ role: "assistant", turn: 1, text: words("b", 40) },
		]);

		const second = await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});
		expect(second.status).toBe("captured");

		const secondEmbedded = embedCalls.flat();
		// The two unchanged leading chunks must NOT be re-embedded.
		expect(secondEmbedded).not.toContain(unchangedChunk0);
		expect(secondEmbedded).not.toContain(unchangedChunk1);
		// Only the changed tail chunk is re-embedded.
		expect(secondEmbedded).toHaveLength(1);
	});

	it("re-embeds only the chunk containing an in-place edit, reusing untouched chunks", async () => {
		const file = path.join(tmp, "transcript.jsonl");
		// ~1100 tokens → three 512-token chunks.
		const base = Array.from({ length: 1100 }, (_, i) => `a${i}`);
		writeTranscript(file, [{ role: "user", turn: 0, text: base.join(" ") }]);
		await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});

		const firstEmbedded = embedCalls.flat();
		expect(firstEmbedded.length).toBeGreaterThanOrEqual(3);
		const chunk0 = firstEmbedded[0];
		const chunk2 = firstEmbedded[2];

		// Edit one word inside chunk 1's token window (~token 602). Same token
		// count → chunk boundaries unchanged → only chunk 1's text differs.
		// The turn number is unchanged, so this exercises content-drift detection.
		embedCalls.length = 0;
		const edited = base.slice();
		edited[600] = "EDITED";
		writeTranscript(file, [{ role: "user", turn: 0, text: edited.join(" ") }]);
		const second = await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});
		expect(second.status).toBe("captured"); // drift detected, not up-to-date

		const secondEmbedded = embedCalls.flat();
		expect(secondEmbedded).not.toContain(chunk0); // prefix chunk reused
		expect(secondEmbedded).not.toContain(chunk2); // suffix chunk reused
		expect(secondEmbedded).toHaveLength(1); // only the edited chunk re-embedded
	});

	it("drops vectors for chunks removed when the transcript shrinks", async () => {
		const file = path.join(tmp, "transcript.jsonl");
		const big = Array.from({ length: 2000 }, (_, i) => `a${i}`);
		writeTranscript(file, [
			{ role: "user", turn: 0, text: big.slice(0, 1000).join(" ") },
			{ role: "assistant", turn: 1, text: big.slice(1000).join(" ") },
		]);
		await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});
		const before = await readChunkVectors(REPO, SESSION, MODEL_NAME);
		const beforeCount = before!.byChunkId.size;
		expect(beforeCount).toBeGreaterThanOrEqual(4);

		// Replace with a much shorter transcript (one short turn → one chunk).
		writeTranscript(file, [
			{ role: "user", turn: 0, text: big.slice(0, 400).join(" ") },
		]);
		const second = await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});
		expect(second.status).toBe("captured"); // shrink detected, not up-to-date

		const chunks = await readAllChunks(REPO, SESSION);
		const after = await readChunkVectors(REPO, SESSION, MODEL_NAME);
		expect(chunks.length).toBeLessThan(beforeCount); // fewer chunks now
		expect(after!.byChunkId.size).toBe(chunks.length); // no stale vectors linger
		for (const id of after!.byChunkId.keys()) {
			expect(id).toBeLessThan(chunks.length);
		}
	});

	it("still produces a vector for every chunk after an incremental capture (no coverage regression)", async () => {
		const file = path.join(tmp, "transcript.jsonl");
		writeTranscript(file, [{ role: "user", turn: 0, text: words("a", 1100) }]);
		await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});
		writeTranscript(file, [
			{ role: "user", turn: 0, text: words("a", 1100) },
			{ role: "assistant", turn: 1, text: words("b", 40) },
		]);
		await captureSession({
			repoKey: REPO,
			sessionId: SESSION,
			transcriptPath: file,
			embed: true,
		});

		const chunks = await readAllChunks(REPO, SESSION);
		const vecs = await readChunkVectors(REPO, SESSION, MODEL_NAME);
		expect(vecs).not.toBeNull();
		// Every current chunk id has a (hash-valid) vector.
		for (const c of chunks) {
			expect(vecs!.byChunkId.has(c.id)).toBe(true);
		}
		expect(vecs!.dim).toBe(384);
	});
});
