import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { rehydrateRepo } from "../../src/lib/index.js";
import {
	openLifecycle,
	createMemory,
} from "../../src/lib/memory/lifecycle.js";

describe("rehydration briefing — memory digest section", () => {
	let cacheHome: string;
	let repoPath: string;

	beforeEach(() => {
		// Resolve realpath to avoid macOS /var → /private/var symlink issues
		// that make resolveRepoIdentity hash two different paths for the
		// "same" worktree (first call: input path; second call inside
		// indexRepo: --show-toplevel which returns realpath).
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "rehydrate-digest-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		repoPath = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "rehydrate-repo-")),
		);
		execFileSync("git", ["init", repoPath]);
		execFileSync("git", ["-C", repoPath, "config", "user.email", "t@t"]);
		execFileSync("git", ["-C", repoPath, "config", "user.name", "t"]);
		execFileSync("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
		fs.writeFileSync(
			path.join(repoPath, "package.json"),
			JSON.stringify({ name: "rd-test", version: "1.0.0" }),
		);
		fs.writeFileSync(path.join(repoPath, "README.md"), "# rd\n");
		execFileSync("git", ["-C", repoPath, "add", "."]);
		execFileSync("git", ["-C", repoPath, "commit", "-m", "init"]);
	});

	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(cacheHome, { recursive: true, force: true });
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it("includes the memory digest when memories exist", async () => {
		// Resolve repoKey by triggering rehydrate once (no memories yet)
		const r0 = await rehydrateRepo(repoPath, {});
		const repoKey = r0.cache.repoKey;

		// Add a memory (source: "explicit" creates as active — no confirm needed).
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Use POST for create endpoints",
				body: "## Decision\nuse POST",
				scope: { files: ["src/api.ts"], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		// Rehydrate again, read the briefing
		const r1 = await rehydrateRepo(repoPath, {});
		const md = fs.readFileSync(r1.briefingPath, "utf8");
		expect(md).toContain("Memory available");
		expect(md).toContain("Use POST for create endpoints");
		expect(md).toContain("How to consult");
	});

	it("omits the digest section when the store is empty", async () => {
		const r = await rehydrateRepo(repoPath, {});
		const md = fs.readFileSync(r.briefingPath, "utf8");
		expect(md).not.toContain("Memory available");
	});

	it("surfaces freshly bootstrapped candidates in the rendered briefing's Pending review section", async () => {
		// Resolve repoKey by triggering rehydrate once (no memories yet).
		const r0 = await rehydrateRepo(repoPath, {});
		const repoKey = r0.cache.repoKey;

		// Simulate a bootstrap pass: 5 raw extracted candidates, none pinned,
		// no get_count, no re_extract bumps. Under the OLD predicate the
		// briefing would surface 0 in pending; the new predicate surfaces all 5.
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			for (let i = 0; i < 5; i++) {
				await createMemory(lc, {
					type: "decision",
					title: `raw candidate ${i}`,
					body: `## Body\nbody ${i}`,
					scope: { files: [], tags: [] },
					source: "extracted",
				});
			}
		} finally {
			lc.close();
		}

		// Re-rehydrate, read the actual on-disk briefing markdown.
		const r1 = await rehydrateRepo(repoPath, {});
		const md = fs.readFileSync(r1.briefingPath, "utf8");

		expect(md).toMatch(/## Pending review — 5 candidates eligible for cleanup/);
		expect(md).toContain("list_memories_pending_rewrite");
		expect(md).toContain("rewrite_memory");
		expect(md).toContain("deprecate_memory");
		// Section ordering: Pending review appears before "How to consult".
		expect(md.indexOf("## Pending review")).toBeLessThan(md.indexOf("How to consult"));
	});
});
