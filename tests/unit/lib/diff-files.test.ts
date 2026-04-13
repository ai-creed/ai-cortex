// tests/unit/lib/diff-files.test.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashFileContent, diffChangedFiles } from "../../../src/lib/diff-files.js";
import type { RepoCache, RepoIdentity } from "../../../src/lib/models.js";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-diff-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function initRepo(dir: string): void {
	execFileSync("git", ["init", dir]);
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
	execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
	execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

function makeIdentity(dir: string): RepoIdentity {
	return {
		repoKey: "testrepokey00000",
		worktreeKey: "testworktreekey00",
		gitCommonDir: path.join(dir, ".git"),
		worktreePath: dir,
	};
}

function makeCache(
	dir: string,
	files: { path: string; contentHash: string }[],
	overrides?: Partial<RepoCache>,
): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "testrepokey00000",
		worktreeKey: "testworktreekey00",
		worktreePath: dir,
		indexedAt: "2026-01-01T00:00:00.000Z",
		fingerprint: "0000000000000000000000000000000000000000",
		packageMeta: { name: "test", version: "1.0.0", framework: null },
		entryFiles: [],
		files: files.map((f) => ({ path: f.path, kind: "file" as const, contentHash: f.contentHash })),
		docs: [],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

describe("hashFileContent", () => {
	it("returns SHA-256 hex of file content", () => {
		const content = "export const x = 1;\n";
		fs.writeFileSync(path.join(tmpDir, "a.ts"), content);
		const expected = createHash("sha256").update(content).digest("hex");

		expect(hashFileContent(tmpDir, "a.ts")).toBe(expected);
	});

	it("returns different hash for different content", () => {
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "const a = 1;\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "const b = 2;\n");

		expect(hashFileContent(tmpDir, "a.ts")).not.toBe(
			hashFileContent(tmpDir, "b.ts"),
		);
	});

	it("returns same hash for identical content", () => {
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "same\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "same\n");

		expect(hashFileContent(tmpDir, "a.ts")).toBe(
			hashFileContent(tmpDir, "b.ts"),
		);
	});
});

describe("diffChangedFiles — hash comparison fallback", () => {
	it("detects changed file by content hash mismatch", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "changed\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);

		const oldHash = createHash("sha256").update("original\n").digest("hex");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: oldHash }]);
		// Set fingerprint to an unreachable commit to force hash-compare tier
		cache.fingerprint = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("hash-compare");
		expect(diff.changed).toContain("a.ts");
	});

	it("detects removed file (in cache, not on disk)", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "keep\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);

		const hash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [
			{ path: "a.ts", contentHash: hash },
			{ path: "gone.ts", contentHash: "somehash" },
		]);
		cache.fingerprint = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("hash-compare");
		expect(diff.removed).toContain("gone.ts");
		expect(diff.changed).not.toContain("a.ts");
	});

	it("detects added file (on disk, no cached hash)", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "old\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "new\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);

		const hashA = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: hashA }]);
		cache.fingerprint = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("hash-compare");
		expect(diff.changed).toContain("b.ts");
	});

	it("returns empty diff when nothing changed", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "same\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);

		const hash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: hash }]);
		cache.fingerprint = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.changed).toEqual([]);
		expect(diff.removed).toEqual([]);
	});
});

describe("diffChangedFiles — git diff tier", () => {
	it("detects modified file between commits", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "original\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const oldHead = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		// Cache at old HEAD
		const oldHash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: oldHash }], {
			fingerprint: oldHead,
		});

		// Modify and commit
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "modified\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "modify"]);

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		expect(diff.changed).toContain("a.ts");
	});

	it("detects added file in new commit", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "keep\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const oldHead = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		const hashA = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: hashA }], {
			fingerprint: oldHead,
		});

		// Add new file and commit
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "new\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "add b"]);

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		expect(diff.changed).toContain("b.ts");
		expect(diff.changed).not.toContain("a.ts");
	});

	it("detects unstaged changes", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "original\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const head = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		const oldHash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: oldHash }], {
			fingerprint: head,
		});

		// Modify without committing
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "dirty\n");

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		expect(diff.changed).toContain("a.ts");
	});

	it("detects staged changes", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "original\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const head = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		const oldHash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: oldHash }], {
			fingerprint: head,
		});

		// Stage a change
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "staged\n");
		execFileSync("git", ["-C", tmpDir, "add", "a.ts"]);

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		expect(diff.changed).toContain("a.ts");
	});

	it("detects untracked files", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "keep\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const head = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		const hashA = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: hashA }], {
			fingerprint: head,
		});

		// Add untracked file
		fs.writeFileSync(path.join(tmpDir, "new.ts"), "untracked\n");

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		expect(diff.changed).toContain("new.ts");
	});

	it("hash validation filters out already-processed dirty files", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "dirty content\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const head = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		// Modify file (makes worktree dirty)
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "modified\n");

		// Cache already has the modified content hash (simulating prior incremental)
		const currentHash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(
			tmpDir,
			[{ path: "a.ts", contentHash: currentHash }],
			{ fingerprint: head },
		);

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		// a.ts is dirty relative to HEAD but hash matches cache — should be filtered out
		expect(diff.changed).not.toContain("a.ts");
	});

	it("repeated call on same dirty worktree returns empty diff", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "original\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const head = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		// Dirty the worktree
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "dirty\n");
		const dirtyHash = hashFileContent(tmpDir, "a.ts");

		// Cache simulates prior incremental that already processed this dirty state
		const cache = makeCache(
			tmpDir,
			[{ path: "a.ts", contentHash: dirtyHash }],
			{ fingerprint: head },
		);

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.changed).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	it("falls back to hash compare when ancestor commit unreachable", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "content\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);

		const hash = hashFileContent(tmpDir, "a.ts");
		const cache = makeCache(tmpDir, [{ path: "a.ts", contentHash: hash }], {
			fingerprint: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		});

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("hash-compare");
	});

	it("detects removed file via git diff tier", () => {
		initRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "keep\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "delete me\n");
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
		const oldHead = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();

		const hashA = hashFileContent(tmpDir, "a.ts");
		const hashB = hashFileContent(tmpDir, "b.ts");
		const cache = makeCache(
			tmpDir,
			[
				{ path: "a.ts", contentHash: hashA },
				{ path: "b.ts", contentHash: hashB },
			],
			{ fingerprint: oldHead },
		);

		// Delete b.ts and commit
		fs.rmSync(path.join(tmpDir, "b.ts"));
		execFileSync("git", ["-C", tmpDir, "add", "."]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "remove b"]);

		const diff = diffChangedFiles(makeIdentity(tmpDir), cache);

		expect(diff.method).toBe("git-diff");
		expect(diff.removed).toContain("b.ts");
		expect(diff.changed).not.toContain("a.ts");
	});
});
