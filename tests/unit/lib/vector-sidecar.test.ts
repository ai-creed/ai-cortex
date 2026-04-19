// tests/unit/lib/vector-sidecar.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readVectorIndex,
	writeVectorIndex,
} from "../../../src/lib/vector-sidecar.js";
import { VectorIndexCorruptError } from "../../../src/lib/models.js";
import type { VectorIndex, SidecarMeta } from "../../../src/lib/vector-sidecar.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vector-sidecar-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeVectorIndex / readVectorIndex", () => {
	it("round-trips a small VectorIndex", () => {
		const index: VectorIndex = {
			meta: {
				modelName: "Xenova/all-MiniLM-L6-v2",
				dim: 3,
				count: 2,
				entries: [
					{ path: "src/foo.ts", hash: "abc123" },
					{ path: "src/bar.ts", hash: "def456" },
				],
			},
			matrix: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
		};

		writeVectorIndex(tmpDir, index);

		const result = readVectorIndex(tmpDir, "Xenova/all-MiniLM-L6-v2");
		expect(result).not.toBeNull();
		if (!result) throw new Error("readVectorIndex returned null for existing sidecar");

		expect(result.meta.modelName).toBe("Xenova/all-MiniLM-L6-v2");
		expect(result.meta.dim).toBe(3);
		expect(result.meta.count).toBe(2);
		expect(result.meta.entries).toEqual([
			{ path: "src/foo.ts", hash: "abc123" },
			{ path: "src/bar.ts", hash: "def456" },
		]);
		expect(result.matrix).toBeInstanceOf(Float32Array);

		// Manual loop for toBeCloseTo on arrays
		const actual = Array.from(result.matrix);
		const expected = Array.from(index.matrix);
		for (let i = 0; i < expected.length; i++) {
			expect(actual[i]).toBeCloseTo(expected[i]!, 5);
		}
	});

	it("returns null when no sidecar exists", () => {
		const result = readVectorIndex(tmpDir, "Xenova/all-MiniLM-L6-v2");
		expect(result).toBeNull();
	});

	it("returns null when modelName does not match", () => {
		const index: VectorIndex = {
			meta: {
				modelName: "Xenova/all-MiniLM-L6-v2",
				dim: 3,
				count: 1,
				entries: [{ path: "src/foo.ts", hash: "abc" }],
			},
			matrix: new Float32Array([0.1, 0.2, 0.3]),
		};
		writeVectorIndex(tmpDir, index);
		const result = readVectorIndex(tmpDir, "some-other-model");
		expect(result).toBeNull();
	});

	it("throws VectorIndexCorruptError when .bin is truncated", () => {
		const index: VectorIndex = {
			meta: {
				modelName: "Xenova/all-MiniLM-L6-v2",
				dim: 2,
				count: 2,
				entries: [
					{ path: "a.ts", hash: "h1" },
					{ path: "b.ts", hash: "h2" },
				],
			},
			matrix: new Float32Array([1, 2, 3, 4]),
		};
		writeVectorIndex(tmpDir, index);
		// Truncate the .bin file to half its size
		const binPath = path.join(tmpDir, ".vectors.bin");
		const stat = fs.statSync(binPath);
		fs.truncateSync(binPath, Math.floor(stat.size / 2));

		expect(() => readVectorIndex(tmpDir, "Xenova/all-MiniLM-L6-v2")).toThrow(
			VectorIndexCorruptError,
		);
	});

	it("throws VectorIndexCorruptError when entries.length mismatches meta.count", () => {
		// Write a valid sidecar, then overwrite meta.json with mismatched count
		const index: VectorIndex = {
			meta: {
				modelName: "Xenova/all-MiniLM-L6-v2",
				dim: 2,
				count: 1,
				entries: [{ path: "a.ts", hash: "h1" }],
			},
			matrix: new Float32Array([1, 2]),
		};
		writeVectorIndex(tmpDir, index);

		// Overwrite meta with count=2 but entries has only 1 entry
		const metaPath = path.join(tmpDir, ".vectors.meta.json");
		const meta: SidecarMeta = {
			modelName: "Xenova/all-MiniLM-L6-v2",
			dim: 2,
			count: 2,
			entries: [{ path: "a.ts", hash: "h1" }],
		};
		fs.writeFileSync(metaPath, JSON.stringify(meta), "utf8");

		expect(() => readVectorIndex(tmpDir, "Xenova/all-MiniLM-L6-v2")).toThrow(
			VectorIndexCorruptError,
		);
	});
});
