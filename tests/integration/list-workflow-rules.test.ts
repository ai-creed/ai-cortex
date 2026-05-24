import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { runListWorkflowRules } from "../../src/lib/memory/cli/list-workflow-rules.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("list-workflow-rules");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

function capture() {
	const buf: string[] = [];
	return {
		stdout: { write: (s: string) => (buf.push(s), true) },
		text: () => buf.join(""),
	};
}

async function seedOne(): Promise<string> {
	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		return await createMemory(lc, {
			type: "decision",
			title: "Always use favro-commit-auto",
			body: "## Rule\nbody",
			scope: { files: [], tags: ["commit", "favro-commit-auto"] },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
}

describe("runListWorkflowRules", () => {
	it("format=hook emits JSON with hookSpecificOutput containing additionalContext", async () => {
		const id = await seedOne();
		const out = capture();
		await runListWorkflowRules({
			repoKey,
			limit: 10,
			format: "hook",
			stdout: out.stdout,
		});
		const parsed = JSON.parse(out.text());
		expect(parsed.hookSpecificOutput).toBeDefined();
		expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(parsed.hookSpecificOutput.additionalContext).toContain(id);
		expect(parsed.hookSpecificOutput.additionalContext).toContain(
			"Workflow rules — 1 active",
		);
	});

	it("format=hook on empty store emits JSON with no additionalContext field (or empty string)", async () => {
		const out = capture();
		await runListWorkflowRules({
			repoKey,
			limit: 10,
			format: "hook",
			stdout: out.stdout,
		});
		const parsed = JSON.parse(out.text());
		const ctx = parsed.hookSpecificOutput?.additionalContext;
		expect(ctx === undefined || ctx === "").toBe(true);
	});

	it("format=text emits human-readable body", async () => {
		const id = await seedOne();
		const out = capture();
		await runListWorkflowRules({
			repoKey,
			limit: 10,
			format: "text",
			stdout: out.stdout,
		});
		expect(out.text()).toContain(id);
		expect(out.text()).toContain("Workflow rules — 1 active");
	});

	it("format=json emits a structured array", async () => {
		const id = await seedOne();
		const out = capture();
		await runListWorkflowRules({
			repoKey,
			limit: 10,
			format: "json",
			stdout: out.stdout,
		});
		const parsed = JSON.parse(out.text());
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.find((r: { id: string }) => r.id === id)).toBeDefined();
	});
});
