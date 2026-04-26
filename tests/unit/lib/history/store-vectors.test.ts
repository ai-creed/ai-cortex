import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeChunkVectors, readChunkVectors, writeAllChunks, sessionDir } from "../../../../src/lib/history/store.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-vec-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "Xenova/all-MiniLM-L6-v2";
const DIM = 4;

function vec(values: number[]): Float32Array {
	return Float32Array.from(values);
}

function sha(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

describe("writeChunkVectors + readChunkVectors", () => {
	it("round-trips chunk vectors with id encoding", () => {
		const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]);
		writeAllChunks("REPO", "abc", [
			{ id: 0, text: "a" },
			{ id: 1, text: "b" },
		]);
		writeChunkVectors("REPO", "abc", {
			modelName: MODEL,
			dim: DIM,
			chunks: [
				{ id: 0, text: "a", vector: vec([1, 0, 0, 0]) },
				{ id: 1, text: "b", vector: vec([0, 1, 0, 0]) },
			],
		});
		const read = readChunkVectors("REPO", "abc", MODEL);
		expect(read).not.toBeNull();
		expect(read!.byChunkId.get(0)).toEqual(vec([1, 0, 0, 0]));
		expect(read!.byChunkId.get(1)).toEqual(vec([0, 1, 0, 0]));
		expect(matrix.length).toBe(8); // sanity
	});

	it("readChunkVectors returns null on model mismatch", () => {
		writeAllChunks("REPO", "abc", [{ id: 0, text: "x" }]);
		writeChunkVectors("REPO", "abc", {
			modelName: MODEL,
			dim: DIM,
			chunks: [{ id: 0, text: "x", vector: vec([1, 0, 0, 0]) }],
		});
		expect(readChunkVectors("REPO", "abc", "OTHER_MODEL")).toBeNull();
	});

	it("returns null when no vectors written", () => {
		expect(readChunkVectors("REPO", "abc", MODEL)).toBeNull();
	});

	it("encodes path as 'chunk:<id>' and hash as sha256(text)", () => {
		writeChunkVectors("REPO", "abc", {
			modelName: MODEL,
			dim: DIM,
			chunks: [{ id: 7, text: "hello", vector: vec([0, 0, 0, 1]) }],
		});
		const meta = JSON.parse(fs.readFileSync(path.join(sessionDir("REPO", "abc"), ".vectors.meta.json"), "utf8"));
		expect(meta.entries).toEqual([{ path: "chunk:7", hash: sha("hello") }]);
		expect(meta.modelName).toBe(MODEL);
		expect(meta.dim).toBe(DIM);
		expect(meta.count).toBe(1);
	});

	it("returns null when all chunk texts have changed since embedding (stale vectors)", () => {
		writeAllChunks("REPO", "abc", [{ id: 0, text: "original text" }]);
		writeChunkVectors("REPO", "abc", {
			modelName: MODEL,
			dim: DIM,
			chunks: [{ id: 0, text: "original text", vector: vec([1, 0, 0, 0]) }],
		});
		// Overwrite chunks with different text — vectors are now stale
		writeAllChunks("REPO", "abc", [{ id: 0, text: "completely different text" }]);
		expect(readChunkVectors("REPO", "abc", MODEL)).toBeNull();
	});
});
