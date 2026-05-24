import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { openMemoryIndex } from "../../src/lib/memory/index.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import { runSurfaceHook } from "../../src/lib/memory/cli/surface-hook.js";
import { runListWorkflowRules } from "../../src/lib/memory/cli/list-workflow-rules.js";
import { rehydrateRepo } from "../../src/lib/rehydrate.js";

type Snap = { id: string; get_count: number; last_accessed_at: string | null };

function snapshotCounters(repoKey: string): Snap[] {
	const idx = openMemoryIndex(repoKey);
	try {
		return idx
			.rawDb()
			.prepare(
				"SELECT id, get_count, last_accessed_at FROM memories ORDER BY id ASC",
			)
			.all() as Snap[];
	} finally {
		idx.close();
	}
}

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
let repoKey: string;

beforeEach(async () => {
	tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-cortex-usage-signal-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	const initialRoot = setUpGitRepo(tmp);
	// Canonicalize so resolveRepoIdentity inside the hook matches the test's view.
	const identity = resolveRepoIdentity(initialRoot);
	repoRoot = identity.worktreePath;
	repoKey = identity.repoKey;

	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		await createMemory(lc, {
			type: "decision",
			title: "file-scope rule",
			body: "## Rule\nfile",
			scope: { files: ["**/*.app-test.ts"], tags: [] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "decision",
			title: "tag-only rule",
			body: "## Rule\ntag",
			scope: { files: [], tags: ["unit-tests", "assertions"] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "how-to",
			title: "how-to rule",
			body: "## How-to\nbody",
			scope: { files: [], tags: ["rebase", "git"] },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
});
afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fsp.rm(tmp, { recursive: true, force: true });
});

async function runHook(file_path: string): Promise<void> {
	const input = JSON.stringify({
		session_id: "sess-inv",
		cwd: repoRoot,
		tool_name: "Edit",
		tool_input: { file_path },
	});
	const buf: string[] = [];
	await runSurfaceHook({
		stdin: Readable.from([input]),
		stdout: { write: (s: string) => (buf.push(s), true) },
	});
}

describe("usage-signal invariant: surfacing never bumps getCount / last_accessed_at", () => {
	it("runSurfaceHook Tier 1 hit does not mutate counters", async () => {
		const before = snapshotCounters(repoKey);
		await runHook(`${repoRoot}/Services/foo.app-test.ts`);
		const after = snapshotCounters(repoKey);
		expect(after).toEqual(before);
	});

	it("runSurfaceHook Tier 2 hit does not mutate counters", async () => {
		const before = snapshotCounters(repoKey);
		await runHook(`${repoRoot}/Services/foo.unit-tests-helper.ts`);
		const after = snapshotCounters(repoKey);
		expect(after).toEqual(before);
	});

	it("runSurfaceHook mixed Tier 1 + Tier 2 does not mutate counters", async () => {
		const before = snapshotCounters(repoKey);
		await runHook(`${repoRoot}/Services/foo.app-test.ts`);
		const after = snapshotCounters(repoKey);
		expect(after).toEqual(before);
	});

	it("list-workflow-rules --format=hook does not mutate counters", async () => {
		const before = snapshotCounters(repoKey);
		const buf: string[] = [];
		await runListWorkflowRules({
			repoKey,
			limit: 10,
			format: "hook",
			stdout: { write: (s: string) => (buf.push(s), true) },
		});
		const after = snapshotCounters(repoKey);
		expect(after).toEqual(before);
	});

	it("rehydrate_project briefing render does not mutate counters", async () => {
		const before = snapshotCounters(repoKey);
		await rehydrateRepo(repoRoot);
		const after = snapshotCounters(repoKey);
		expect(after).toEqual(before);
	});
});
