// tests/unit/lib/cache-store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import {
	buildRepoFingerprint,
	isWorktreeDirty,
	readCacheForWorktree,
	writeCache,
} from "../../../src/lib/cache-store.js";

const mockExec = vi.mocked(execFileSync);

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-04-10T00:00:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test", version: "1.0.0", framework: null },
		entryFiles: [],
		files: [],
		docs: [],
		imports: [],
		...overrides,
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cache-test-"));
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeCache + readCacheForWorktree", () => {
	it("writes and reads back a cache", () => {
		const cache = makeCache();
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

		writeCache(cache);
		const result = readCacheForWorktree(cache.repoKey, cache.worktreeKey);

		expect(result).not.toBeNull();
		expect(result?.fingerprint).toBe("abc123");
		expect(result?.packageMeta.name).toBe("test");
	});

	it("returns null when no cache file exists", () => {
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		expect(readCacheForWorktree("unknown", "key")).toBeNull();
	});

	it("returns null and warns to stderr on schema version mismatch", () => {
		const cache = makeCache({ schemaVersion: "0" as any });
		vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		writeCache(cache);
		const result = readCacheForWorktree(cache.repoKey, cache.worktreeKey);

		expect(result).toBeNull();
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("cache schema updated"),
		);
	});
});

describe("buildRepoFingerprint", () => {
	it("returns trimmed HEAD commit hash from git", () => {
		mockExec.mockReturnValue("abc123def456\n" as any);
		expect(buildRepoFingerprint("/repo")).toBe("abc123def456");
	});
});

describe("isWorktreeDirty", () => {
	it("returns false when git status output is empty", () => {
		mockExec.mockReturnValue("" as any);
		expect(isWorktreeDirty("/repo")).toBe(false);
	});

	it("returns true when git status output contains tracked or untracked changes", () => {
		mockExec.mockReturnValue(" M src/main.ts\n?? newfile.ts\n" as any);
		expect(isWorktreeDirty("/repo")).toBe(true);
	});
});
