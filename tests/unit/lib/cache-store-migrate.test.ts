import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runRepoKeyMigrationIfNeeded,
	SENTINEL_NAME,
	discoverLiteralCandidates,
} from "../../../src/lib/cache-store-migrate.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runRepoKeyMigrationIfNeeded — sentinel fast-path", () => {
	it("returns already-migrated and writes no work when sentinel exists", async () => {
		const repoKey = "0123456789abcdef";
		const dir = path.join(tmp, repoKey);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, SENTINEL_NAME),
			JSON.stringify({ migratedAt: "2026-05-04T00:00:00Z", outcomes: [] }),
		);

		const result = await runRepoKeyMigrationIfNeeded(repoKey, "/tmp");

		expect(result.outcome).toBe("already-migrated");
		expect(result.details).toEqual([]);
	});
});

function gitInit(dir: string, branch = "main") {
	execFileSync("git", ["-C", dir, "init", "-b", branch], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
}

describe("discoverLiteralCandidates", () => {
	it("includes worktree basename, repo-root basename, and branch name", () => {
		const repoRoot = path.join(tmp, "MyRepo");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot, "feature-x");

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates).toContain("MyRepo");
		expect(candidates).toContain("feature-x");
	});

	it("dedups when worktree basename equals branch name", () => {
		const repoRoot = path.join(tmp, "Repo");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot, "Repo");

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates.filter((c) => c === "Repo")).toHaveLength(1);
	});

	it("excludes the reserved 'global' literal", () => {
		const repoRoot = path.join(tmp, "global");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot);

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates).not.toContain("global");
	});

	it("excludes 16-hex-shaped names", () => {
		const repoRoot = path.join(tmp, "0123456789abcdef");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot);

		const candidates = discoverLiteralCandidates(repoRoot);

		expect(candidates).not.toContain("0123456789abcdef");
	});

	it("swallows detached-HEAD (no branch) without throwing", () => {
		const repoRoot = path.join(tmp, "detached");
		fs.mkdirSync(repoRoot);
		gitInit(repoRoot);
		execFileSync("git", ["-C", repoRoot, "checkout", "--detach", "HEAD"], {
			stdio: "ignore",
		});

		expect(() => discoverLiteralCandidates(repoRoot)).not.toThrow();
		const candidates = discoverLiteralCandidates(repoRoot);
		expect(candidates).toContain("detached");
	});
});
