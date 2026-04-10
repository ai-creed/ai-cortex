// tests/integration/index.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCachedIndex, indexRepo } from "../../src/lib/index.js";
import { SCHEMA_VERSION } from "../../src/lib/models.js";

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-integration-"));

	// Set up a minimal git repo
	execFileSync("git", ["init", tmpDir]);
	execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);

	// Add files
	fs.writeFileSync(
		path.join(tmpDir, "README.md"),
		"# Test Repo\nA minimal test repo.\n",
	);
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, "src", "main.ts"),
		"export const x = 1;\n",
	);
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "test-repo", version: "0.0.1" }),
	);

	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("indexRepo + getCachedIndex (real disk + real git)", () => {
	it("builds a RepoCache with correct shape", () => {
		const cache = indexRepo(tmpDir);

		expect(cache.schemaVersion).toBe(SCHEMA_VERSION);
		expect(cache.repoKey).toHaveLength(16);
		expect(cache.worktreeKey).toHaveLength(16);
		expect(cache.worktreePath).toBe(fs.realpathSync(tmpDir));
		expect(cache.fingerprint).toHaveLength(40);
		expect(cache.packageMeta.name).toBe("test-repo");
		expect(cache.files.some((f) => f.path === "README.md")).toBe(true);
		expect(cache.docs[0]?.path).toBe("README.md");
		expect(cache.docs[0]?.title).toBe("Test Repo");
	});

	it("getCachedIndex returns the cache when fingerprint is fresh", () => {
		const result = getCachedIndex(tmpDir);
		expect(result).not.toBeNull();
		expect(result?.packageMeta.name).toBe("test-repo");
	});

	it("getCachedIndex returns null after a new commit (stale fingerprint)", () => {
		fs.appendFileSync(path.join(tmpDir, "README.md"), "\nchange\n");
		execFileSync("git", ["-C", tmpDir, "add", "README.md"]);
		execFileSync("git", ["-C", tmpDir, "commit", "-m", "update"]);

		expect(getCachedIndex(tmpDir)).toBeNull();
	});
});
