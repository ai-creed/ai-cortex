import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	historyDir,
	sessionDir,
	sessionJsonPath,
	chunksJsonlPath,
	lockPath,
} from "../../../../src/lib/history/store.js";

describe("store paths", () => {
	it("historyDir uses getCacheDir + 'history'", () => {
		vi.spyOn(os, "homedir").mockReturnValue("/home/u");
		expect(historyDir("aabbccdd00112233")).toBe(
			path.join("/home/u", ".cache", "ai-cortex", "v1", "aabbccdd00112233", "history"),
		);
	});

	it("sessionDir is sessions/<id> under historyDir", () => {
		vi.spyOn(os, "homedir").mockReturnValue("/home/u");
		expect(sessionDir("aabbccdd00112233", "abc")).toBe(
			path.join(
				"/home/u",
				".cache",
				"ai-cortex",
				"v1",
				"aabbccdd00112233",
				"history",
				"sessions",
				"abc",
			),
		);
	});

	it("sessionJsonPath, chunksJsonlPath, lockPath are session-relative", () => {
		vi.spyOn(os, "homedir").mockReturnValue("/home/u");
		const dir = sessionDir("aabbccdd00112233", "abc");
		expect(sessionJsonPath("aabbccdd00112233", "abc")).toBe(path.join(dir, "session.json"));
		expect(chunksJsonlPath("aabbccdd00112233", "abc")).toBe(path.join(dir, "chunks.jsonl"));
		expect(lockPath("aabbccdd00112233", "abc")).toBe(path.join(dir, ".lock"));
	});
});
