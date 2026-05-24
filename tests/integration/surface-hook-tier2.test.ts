import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import { runSurfaceHook } from "../../src/lib/memory/cli/surface-hook.js";

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
	return root;
}

let tmp: string;
let repoRoot: string;
let worktreePath: string;
let repoKey: string;

beforeEach(async () => {
	tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-cortex-tier2-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	repoRoot = setUpGitRepo(tmp);
	// Resolve via the canonicalized worktreePath so the test's repoKey
	// matches what the hook will compute from its `cwd` input (which the
	// hook also routes through resolveRepoIdentity / git on macOS, where
	// /var/folders is a symlink to /private/var/folders).
	const ident0 = resolveRepoIdentity(repoRoot);
	worktreePath = ident0.worktreePath;
	repoKey = resolveRepoIdentity(worktreePath).repoKey;
});
afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fsp.rm(tmp, { recursive: true, force: true });
});

function captureStdout(): {
	stdout: { write: (s: string) => boolean };
	buf: string[];
} {
	const buf: string[] = [];
	return {
		stdout: { write: (s: string) => (buf.push(s), true) },
		buf,
	};
}

describe("runSurfaceHook Tier 2", () => {
	it("emits additionalContext containing a tag-overlap memory when file scope misses", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let memId: string;
		try {
			memId = await createMemory(lc, {
				type: "decision",
				title: "Use strictEqual in unit tests",
				body: "## Rule\nuse strictEqual",
				scope: { files: [], tags: ["unit-tests", "assertions"] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		const input = JSON.stringify({
			session_id: "sess-1",
			cwd: worktreePath,
			tool_name: "Edit",
			tool_input: { file_path: `${worktreePath}/Services/foo.app-test.ts` },
		});
		const { stdout, buf } = captureStdout();
		await runSurfaceHook({ stdin: Readable.from([input]), stdout });

		const out = JSON.parse(buf.join(""));
		expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(out.hookSpecificOutput.additionalContext ?? "").toContain(memId);
	});
});
