import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { runSurfaceHook } from "../../src/lib/memory/cli/surface-hook.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";

let cacheKey: string; // cleanup handle: mkRepoKey sets a temp AI_CORTEX_CACHE_HOME
let repoKey: string; // derived from cwd — the SAME key runSurfaceHook resolves
beforeEach(async () => {
	cacheKey = await mkRepoKey("surface-hook-it"); // isolates the cache dir
	repoKey = resolveRepoIdentity(process.cwd()).repoKey; // what the hook will use
});
afterEach(async () => { await cleanupRepo(cacheKey); });

function captureStdout() {
	let buf = "";
	return {
		stream: { write: (s: string) => { buf += s; return true; } } as unknown as NodeJS.WriteStream,
		text: () => buf,
	};
}

async function run(payload: unknown) {
	const out = captureStdout();
	const code = await runSurfaceHook({
		stdin: Readable.from([JSON.stringify(payload)]),
		stdout: out.stream,
	});
	return { code, json: JSON.parse(out.text()) };
}

describe("runSurfaceHook (integration)", () => {
	const cwd = process.cwd(); // a real git repo (this repo)

	it("always allows and is silent when nothing matches", async () => {
		const { code, json } = await run({
			session_id: "s1",
			cwd,
			tool_name: "Edit",
			tool_input: { file_path: "no/such/unscoped-file-xyz.ts" },
		});
		expect(code).toBe(0);
		expect(json.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(json.hookSpecificOutput.additionalContext).toBeUndefined();
	});

	it("never emits permissionDecision for a Codex apply_patch (Codex rejects it)", async () => {
		// no-match case: the common path for most edits — must not fail the hook
		const { json } = await run({
			session_id: "cdx-nd", cwd,
			tool_name: "apply_patch",
			tool_input: {
				command: "*** Begin Patch\n*** Add File: no/such/unscoped-xyz.ts\n+x\n*** End Patch\n",
			},
		});
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(json.hookSpecificOutput.hookEventName).toBe("PreToolUse");
	});

	it("surfaces a scoped memory for a Claude Edit", async () => {
		const { worktreePath } = resolveRepoIdentity(cwd);
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "store rule surfaced",
				body: "## r\nx",
				scope: { files: [rel], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}
		const { json } = await run({
			session_id: "s2",
			cwd: worktreePath,
			tool_name: "Write",
			tool_input: { file_path: `${worktreePath}/${rel}` },
		});
		const ctx = json.hookSpecificOutput.additionalContext as string;
		expect(ctx).toContain("store rule surfaced");
		expect(ctx).toContain(rel);
	});

	it("is silent on the second identical edit (dedup)", async () => {
		const { worktreePath } = resolveRepoIdentity(cwd);
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "dedup rule", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		const payload = {
			session_id: "s3", cwd: worktreePath,
			tool_name: "Edit", tool_input: { file_path: `${worktreePath}/${rel}` },
		};
		const first = await run(payload);
		const second = await run(payload);
		expect(first.json.hookSpecificOutput.additionalContext).toContain("dedup rule");
		expect(second.json.hookSpecificOutput.additionalContext).toBeUndefined();
	});

	it("allows silently on malformed stdin", async () => {
		const out = captureStdout();
		const code = await runSurfaceHook({
			stdin: Readable.from(["{not json"]),
			stdout: out.stream,
		});
		expect(code).toBe(0);
		// Harness unknown on parse failure → omit permissionDecision (Claude
		// proceeds via normal flow; Codex would reject the field). Never blocks.
		const ho = JSON.parse(out.text()).hookSpecificOutput;
		expect(ho.hookEventName).toBe("PreToolUse");
		expect(ho.permissionDecision).toBeUndefined();
	});

	it("allows silently when cwd is not a git repo", async () => {
		const { code, json } = await run({
			session_id: "s4", cwd: "/", tool_name: "Edit",
			tool_input: { file_path: "/x.ts" },
		});
		expect(code).toBe(0);
		expect(json.hookSpecificOutput.additionalContext).toBeUndefined();
	});

	it("respects AI_CORTEX_SURFACE=0", async () => {
		const prev = process.env.AI_CORTEX_SURFACE;
		process.env.AI_CORTEX_SURFACE = "0";
		try {
			const { worktreePath } = resolveRepoIdentity(process.cwd());
			const { json } = await run({
				session_id: "s5", cwd: worktreePath, tool_name: "Edit",
				tool_input: { file_path: `${worktreePath}/src/lib/memory/store.ts` },
			});
			expect(json.hookSpecificOutput.additionalContext).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.AI_CORTEX_SURFACE;
			else process.env.AI_CORTEX_SURFACE = prev;
		}
	});

	it("surfaces for a Codex apply_patch", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "codex patch rule", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		const command = [
			"*** Begin Patch",
			`*** Update File: ${rel}`,
			"@@", "-a", "+b",
			"*** End Patch",
		].join("\n");
		const { json } = await run({
			session_id: "cdx1", cwd: worktreePath,
			tool_name: "apply_patch", tool_input: { command },
		});
		expect(json.hookSpecificOutput.additionalContext as string).toContain(
			"codex patch rule",
		);
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
	});

	it("caps at 5 memories total across a multi-file apply_patch", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const f1 = "src/lib/memory/store.ts";
		const f2 = "src/lib/memory/retrieve.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			for (let i = 0; i < 4; i++)
				await createMemory(lc, {
					type: "decision", title: `s${i}`, body: "## x\ny",
					scope: { files: [f1], tags: [] }, source: "explicit",
				});
			for (let i = 0; i < 4; i++)
				await createMemory(lc, {
					type: "decision", title: `r${i}`, body: "## x\ny",
					scope: { files: [f2], tags: [] }, source: "explicit",
				});
		} finally { lc.close(); }
		const command = [
			"*** Begin Patch",
			`*** Update File: ${f1}`, "@@", "-a", "+b",
			`*** Update File: ${f2}`, "@@", "-c", "+d",
			"*** End Patch",
		].join("\n");
		const { json } = await run({
			session_id: "cdx2", cwd: worktreePath,
			tool_name: "apply_patch", tool_input: { command },
		});
		const ctx = json.hookSpecificOutput.additionalContext as string;
		const bullets = ctx.split("\n").filter((l) => l.startsWith("- ["));
		expect(bullets.length).toBe(5);
	});

	it("abandons to silent-allow when the deadline is exceeded", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "deadline rule", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		const out = captureStdout();
		let calls = 0;
		const code = await runSurfaceHook({
			stdin: Readable.from([
				JSON.stringify({
					session_id: "dl", cwd: worktreePath,
					tool_name: "Edit", tool_input: { file_path: `${worktreePath}/${rel}` },
				}),
			]),
			stdout: out.stream,
			now: () => (calls++ === 0 ? 0 : 1000), // start=0; subsequent checks exceed DEADLINE_MS
		});
		expect(code).toBe(0);
		const json = JSON.parse(out.text());
		expect(json.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(json.hookSpecificOutput.additionalContext).toBeUndefined();
	});

	it("works with no session_id (uses _nosession fallback)", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "nosess rule", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		const { json } = await run({
			cwd: worktreePath, tool_name: "Edit",
			tool_input: { file_path: `${worktreePath}/${rel}` },
		});
		expect(json.hookSpecificOutput.additionalContext as string).toContain(
			"nosess rule",
		);
	});

	it("re-surfaces only the newly-added memory on a later same-file edit (per-memory dedup)", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const rel = "src/lib/memory/store.ts";
		let lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "rule ALPHA", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		const payload = {
			session_id: "churn", cwd: worktreePath,
			tool_name: "Edit" as const, tool_input: { file_path: `${worktreePath}/${rel}` },
		};
		const first = await run(payload);
		expect(first.json.hookSpecificOutput.additionalContext as string).toContain("rule ALPHA");

		lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "rule BETA", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		const second = await run(payload);
		const ctx = second.json.hookSpecificOutput.additionalContext as string;
		expect(ctx).toContain("rule BETA");
		expect(ctx).not.toContain("rule ALPHA"); // already shown this session
	});

	it("logs surface-event paths parallel to memoryIds for the shown pointers", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "paths rule", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		await run({
			session_id: "paths-sess", cwd: worktreePath,
			tool_name: "Edit", tool_input: { file_path: `${worktreePath}/${rel}` },
		});
		const { readSurfaceEvents } = await import("../../src/lib/stats/surface-events.js");
		const ev = readSurfaceEvents(repoKey)[0]!;
		expect(ev.paths).toBeDefined();                       // hook must emit paths
		expect(ev.paths!.length).toBe(ev.memoryIds.length);   // parallel to memoryIds
		expect(ev.paths).toEqual([rel]);                       // corresponds to the shown pointer
	});

	it("emits a surface-events line when it surfaces", async () => {
		const { worktreePath } = resolveRepoIdentity(process.cwd());
		const rel = "src/lib/memory/store.ts";
		const lc = await openLifecycle(repoKey, { agentId: "t" });
		try {
			await createMemory(lc, {
				type: "decision", title: "se rule", body: "## r\nx",
				scope: { files: [rel], tags: [] }, source: "explicit",
			});
		} finally { lc.close(); }
		await run({
			session_id: "se-sess", cwd: worktreePath,
			tool_name: "Edit", tool_input: { file_path: `${worktreePath}/${rel}` },
		});
		const { readSurfaceEvents } = await import(
			"../../src/lib/stats/surface-events.js",
		);
		const evs = readSurfaceEvents(repoKey);
		expect(evs.length).toBe(1);
		expect(evs[0]!.session_id).toBe("se-sess");
		expect(evs[0]!.count).toBeGreaterThan(0);
	});
});
