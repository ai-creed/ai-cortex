import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRepoIdentity } from "../../../src/mcp/server.js";

let tmp: string;
let cacheHome: string;
let repoRoot: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wri-"));
	cacheHome = path.join(tmp, "cache");
	fs.mkdirSync(cacheHome, { recursive: true });
	process.env.AI_CORTEX_CACHE_HOME = cacheHome;
	repoRoot = path.join(tmp, "work", "Repo");
	fs.mkdirSync(repoRoot, { recursive: true });
	execFileSync("git", ["-C", repoRoot, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@t"], { stdio: "ignore" });
	execFileSync("git", ["-C", repoRoot, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", repoRoot, "commit", "--allow-empty", "-m", "i"], { stdio: "ignore" });
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("withRepoIdentity", () => {
	it("derives a 16-hex repoKey from worktreePath and passes it to handler", async () => {
		let captured: string | undefined;
		await withRepoIdentity(repoRoot, async (repoKey) => {
			captured = repoKey;
		});
		expect(captured).toMatch(/^[0-9a-f]{16}$/);
	});

	it("rejects relative paths", async () => {
		await expect(
			withRepoIdentity("relative/path", async () => {}),
		).rejects.toThrow(/absolute/i);
	});

	it("rejects non-git paths", async () => {
		const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "notgit-"));
		try {
			await expect(
				withRepoIdentity(notGit, async () => {}),
			).rejects.toThrow(/git/i);
		} finally {
			fs.rmSync(notGit, { recursive: true, force: true });
		}
	});

	it("runs migration on first call (sentinel written)", async () => {
		let repoKey = "";
		await withRepoIdentity(repoRoot, async (rk) => {
			repoKey = rk;
		});
		expect(
			fs.existsSync(
				path.join(cacheHome, repoKey, ".migration-v1-complete"),
			),
		).toBe(true);
	});
});
