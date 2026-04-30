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
		expect(historyDir("REPO")).toBe(
			path.join("/home/u", ".cache", "ai-cortex", "v1", "REPO", "history"),
		);
	});

	it("sessionDir is sessions/<id> under historyDir", () => {
		vi.spyOn(os, "homedir").mockReturnValue("/home/u");
		expect(sessionDir("REPO", "abc")).toBe(
			path.join(
				"/home/u",
				".cache",
				"ai-cortex",
				"v1",
				"REPO",
				"history",
				"sessions",
				"abc",
			),
		);
	});

	it("sessionJsonPath, chunksJsonlPath, lockPath are session-relative", () => {
		vi.spyOn(os, "homedir").mockReturnValue("/home/u");
		const dir = sessionDir("REPO", "abc");
		expect(sessionJsonPath("REPO", "abc")).toBe(path.join(dir, "session.json"));
		expect(chunksJsonlPath("REPO", "abc")).toBe(path.join(dir, "chunks.jsonl"));
		expect(lockPath("REPO", "abc")).toBe(path.join(dir, ".lock"));
	});
});
