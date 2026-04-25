import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAllChunks, getChunkText, readAllChunks, chunksJsonlPath, sessionDir } from "../../../../src/lib/history/store.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-chunks-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeAllChunks + getChunkText", () => {
	it("round-trips a single chunk", () => {
		writeAllChunks("REPO", "abc", [{ id: 0, text: "hello world" }]);
		expect(getChunkText("REPO", "abc", 0)).toBe("hello world");
	});

	it("writes multiple chunks readable by id", () => {
		writeAllChunks("REPO", "abc", [
			{ id: 0, text: "first" },
			{ id: 1, text: "second" },
		]);
		expect(getChunkText("REPO", "abc", 0)).toBe("first");
		expect(getChunkText("REPO", "abc", 1)).toBe("second");
	});

	it("overwrites existing file (full-file replace, not append)", () => {
		writeAllChunks("REPO", "abc", [{ id: 0, text: "old" }, { id: 1, text: "stale" }]);
		writeAllChunks("REPO", "abc", [{ id: 0, text: "new" }]);
		expect(readAllChunks("REPO", "abc")).toEqual([{ id: 0, text: "new" }]);
	});

	it("uses temp+rename — no .tmp left behind", () => {
		writeAllChunks("REPO", "abc", [{ id: 0, text: "x" }]);
		const stragglers = fs.readdirSync(sessionDir("REPO", "abc")).filter((n) => n.endsWith(".tmp"));
		expect(stragglers).toEqual([]);
	});

	it("returns null when chunks file absent", () => {
		expect(getChunkText("REPO", "abc", 0)).toBeNull();
	});

	it("returns null when id not present", () => {
		writeAllChunks("REPO", "abc", [{ id: 0, text: "x" }]);
		expect(getChunkText("REPO", "abc", 99)).toBeNull();
	});

	it("readAllChunks returns full list in id order", () => {
		writeAllChunks("REPO", "abc", [
			{ id: 1, text: "b" },
			{ id: 0, text: "a" },
		]);
		expect(readAllChunks("REPO", "abc")).toEqual([
			{ id: 0, text: "a" },
			{ id: 1, text: "b" },
		]);
	});
});
