import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	writeAllChunks,
	getChunkText,
	readAllChunks,
	sessionDir,
} from "../../../../src/lib/history/store.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-chunks-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeAllChunks + getChunkText", () => {
	it("round-trips a single chunk", async () => {
		await writeAllChunks("aabbccdd00112233", "abc", [{ id: 0, text: "hello world" }]);
		expect(await getChunkText("aabbccdd00112233", "abc", 0)).toBe("hello world");
	});

	it("writes multiple chunks readable by id", async () => {
		await writeAllChunks("aabbccdd00112233", "abc", [
			{ id: 0, text: "first" },
			{ id: 1, text: "second" },
		]);
		expect(await getChunkText("aabbccdd00112233", "abc", 0)).toBe("first");
		expect(await getChunkText("aabbccdd00112233", "abc", 1)).toBe("second");
	});

	it("overwrites existing file (full-file replace, not append)", async () => {
		await writeAllChunks("aabbccdd00112233", "abc", [
			{ id: 0, text: "old" },
			{ id: 1, text: "stale" },
		]);
		await writeAllChunks("aabbccdd00112233", "abc", [{ id: 0, text: "new" }]);
		expect(await readAllChunks("aabbccdd00112233", "abc")).toEqual([
			{ id: 0, text: "new" },
		]);
	});

	it("uses temp+rename — no .tmp left behind", async () => {
		await writeAllChunks("aabbccdd00112233", "abc", [{ id: 0, text: "x" }]);
		const stragglers = fs
			.readdirSync(sessionDir("aabbccdd00112233", "abc"))
			.filter((n) => n.endsWith(".tmp"));
		expect(stragglers).toEqual([]);
	});

	it("returns null when chunks file absent", async () => {
		expect(await getChunkText("aabbccdd00112233", "abc", 0)).toBeNull();
	});

	it("returns null when id not present", async () => {
		await writeAllChunks("aabbccdd00112233", "abc", [{ id: 0, text: "x" }]);
		expect(await getChunkText("aabbccdd00112233", "abc", 99)).toBeNull();
	});

	it("readAllChunks returns full list in id order", async () => {
		await writeAllChunks("aabbccdd00112233", "abc", [
			{ id: 1, text: "b" },
			{ id: 0, text: "a" },
		]);
		expect(await readAllChunks("aabbccdd00112233", "abc")).toEqual([
			{ id: 0, text: "a" },
			{ id: 1, text: "b" },
		]);
	});
});
