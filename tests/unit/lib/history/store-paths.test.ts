import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	historyDir,
	sessionDir,
	sessionJsonPath,
	chunksJsonlPath,
	lockPath,
} from "../../../../src/lib/history/store.js";

describe("store paths", () => {
	// These tests verify the homedir-based default path resolution: they mock
	// os.homedir and expect getCacheDir to fall back to ~/.cache/ai-cortex/v1.
	// The global vitest setup pins AI_CORTEX_CACHE_HOME to a session tmpdir,
	// which would override that fallback — so unset it here and restore after.
	let savedCacheHome: string | undefined;
	beforeEach(() => {
		savedCacheHome = process.env.AI_CORTEX_CACHE_HOME;
		delete process.env.AI_CORTEX_CACHE_HOME;
	});
	afterEach(() => {
		if (savedCacheHome !== undefined)
			process.env.AI_CORTEX_CACHE_HOME = savedCacheHome;
	});

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
