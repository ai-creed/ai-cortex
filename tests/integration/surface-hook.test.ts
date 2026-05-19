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
		expect(JSON.parse(out.text()).hookSpecificOutput.permissionDecision).toBe("allow");
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
});
