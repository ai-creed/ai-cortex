import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { cacheRoot, statsConfigPath, archiveDir } from "../../../../src/lib/stats/paths.js";

describe("paths", () => {
	const originalEnv = process.env.AI_CORTEX_CACHE_HOME;
	beforeEach(() => { delete process.env.AI_CORTEX_CACHE_HOME; });
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
		else process.env.AI_CORTEX_CACHE_HOME = originalEnv;
	});

	it("cacheRoot defaults to ~/.cache/ai-cortex/v1", () => {
		expect(cacheRoot()).toBe(path.join(os.homedir(), ".cache", "ai-cortex", "v1"));
	});

	it("cacheRoot honors AI_CORTEX_CACHE_HOME", () => {
		process.env.AI_CORTEX_CACHE_HOME = "/tmp/x";
		expect(cacheRoot()).toBe("/tmp/x");
	});

	it("statsConfigPath sits at cache root", () => {
		process.env.AI_CORTEX_CACHE_HOME = "/tmp/x";
		expect(statsConfigPath()).toBe("/tmp/x/stats-config.json");
	});

	it("archiveDir is _archived/<repoKey> under cache root", () => {
		process.env.AI_CORTEX_CACHE_HOME = "/tmp/x";
		expect(archiveDir("29751ede0f594c8a")).toBe("/tmp/x/_archived/29751ede0f594c8a");
	});
});
