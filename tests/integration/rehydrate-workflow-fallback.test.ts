import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import { rehydrateRepo } from "../../src/lib/rehydrate.js";

function setUpGitRepo(base: string, name = "Repo"): string {
	const root = path.join(base, "work", name);
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", root, "config", "user.email", "t@t"], {
		stdio: "ignore",
	});
	execFileSync("git", ["-C", root, "config", "user.name", "t"], {
		stdio: "ignore",
	});
	execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "i"], {
		stdio: "ignore",
	});
	// Resolve realpath to avoid macOS /var → /private/var symlink mismatches
	// across repeated resolveRepoIdentity calls (would otherwise hash to
	// different repoKeys for the same worktree).
	return fs.realpathSync(root);
}

function writeClaudeSettings(home: string, content: object): void {
	const dir = path.join(home, ".claude");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content));
}

let tmp: string;
let repoRoot: string;
let repoKey: string;
let prevHome: string | undefined;
let tmpHome: string;

beforeEach(async () => {
	// Realpath both the cache home and the repo root so that repeated
	// resolveRepoIdentity calls produce a stable repoKey (macOS /var vs
	// /private/var symlink quirk).
	tmp = fs.realpathSync(
		await fsp.mkdtemp(path.join(os.tmpdir(), "ai-cortex-rehydrate-fb-")),
	);
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	const initialRoot = setUpGitRepo(tmp);
	const identity = resolveRepoIdentity(initialRoot);
	repoRoot = identity.worktreePath;
	repoKey = identity.repoKey;

	prevHome = process.env.HOME;
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-rehydrate-home-"));
	process.env.HOME = tmpHome;

	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		await createMemory(lc, {
			type: "decision",
			title: "Always use favro-commit-auto",
			body: "## Rule\nbody",
			scope: { files: [], tags: ["commit", "favro-commit-auto"] },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
});
afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	if (prevHome) process.env.HOME = prevHome;
	else delete process.env.HOME;
	await fsp.rm(tmp, { recursive: true, force: true });
	try {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("rehydrate_project workflow-rules fallback", () => {
	it("section ABSENT when SessionStart workflow-rules hook is installed", async () => {
		writeClaudeSettings(tmpHome, {
			hooks: {
				SessionStart: [
					{
						matcher: "startup|resume|clear|compact",
						hooks: [
							{
								type: "command",
								command:
									"ai-cortex memory list-workflow-rules --format=hook",
								timeout: 10000,
							},
						],
					},
				],
			},
		});

		const { briefingPath } = await rehydrateRepo(repoRoot);
		const md = fs.readFileSync(briefingPath, "utf8");
		expect(md).not.toContain("Workflow rules — 1 active");
	});

	it("section PRESENT when SessionStart workflow-rules hook is NOT installed", async () => {
		const { briefingPath } = await rehydrateRepo(repoRoot);
		const md = fs.readFileSync(briefingPath, "utf8");
		expect(md).toContain("Workflow rules — 1 active");
		expect(md).toContain("favro-commit-auto");
	});
});
