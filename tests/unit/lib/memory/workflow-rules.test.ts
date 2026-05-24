import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import {
	selectWorkflowRules,
	formatWorkflowRulesText,
} from "../../../../src/lib/memory/workflow-rules.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("workflow-rules");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

async function seed(): Promise<void> {
	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		await createMemory(lc, {
			type: "decision",
			title: "Always use favro-commit-auto skill for commits",
			body: "## Rule\nuse the skill",
			scope: { files: [], tags: ["commit", "favro-commit-auto", "git"] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "how-to",
			title: "Rebase recovery how-to",
			body: "## How-to\nthis is a how-to",
			scope: { files: [], tags: ["rebase", "git"] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "decision",
			title: "Decision with file scope — excluded",
			body: "## Rule\nrule body",
			scope: { files: ["src/**/*.ts"], tags: ["x"] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "decision",
			title: "Decision with NO tags — excluded",
			body: "## Rule\nrule body",
			scope: { files: [], tags: [] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "pattern",
			title: "Pattern type — excluded",
			body: "## Pattern",
			scope: { files: [], tags: ["meta"] },
			source: "explicit",
		});
		await createMemory(lc, {
			type: "gotcha",
			title: "Gotcha type — excluded",
			body: "## Gotcha",
			scope: { files: [], tags: ["meta"] },
			source: "explicit",
			typeFields: { severity: "info" },
		});
	} finally {
		lc.close();
	}
}

describe("selectWorkflowRules", () => {
	it("filters to active, no-file-scope, has-tags, type in {decision, how-to}", async () => {
		await seed();
		const idx = openMemoryIndex(repoKey);
		try {
			const rules = selectWorkflowRules(idx, 100);
			const titles = rules.map((r) => r.title).sort();
			expect(titles).toEqual([
				"Always use favro-commit-auto skill for commits",
				"Rebase recovery how-to",
			]);
		} finally {
			idx.close();
		}
	});

	it("returns empty when no memories qualify", async () => {
		const idx = openMemoryIndex(repoKey);
		try {
			expect(selectWorkflowRules(idx, 10)).toEqual([]);
		} finally {
			idx.close();
		}
	});

	it("respects the cap", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			for (let i = 0; i < 5; i++) {
				await createMemory(lc, {
					type: "decision",
					title: `Rule ${i}`,
					body: "## Rule\nrule body",
					scope: { files: [], tags: ["test"] },
					source: "explicit",
				});
			}
		} finally {
			lc.close();
		}
		const idx = openMemoryIndex(repoKey);
		try {
			expect(selectWorkflowRules(idx, 3).length).toBe(3);
		} finally {
			idx.close();
		}
	});

	it("sorts pinned first, then by getCount desc, then by updatedAt desc", async () => {
		const idx = openMemoryIndex(repoKey);
		try {
			const lc = await openLifecycle(repoKey, { agentId: "test" });
			let idA: string, idB: string, idC: string;
			try {
				idA = await createMemory(lc, {
					type: "decision",
					title: "A — pinned",
					body: "## Rule\nbody",
					scope: { files: [], tags: ["test"] },
					source: "explicit",
				});
				idB = await createMemory(lc, {
					type: "decision",
					title: "B — high getCount",
					body: "## Rule\nbody",
					scope: { files: [], tags: ["test"] },
					source: "explicit",
				});
				idC = await createMemory(lc, {
					type: "decision",
					title: "C — most recent",
					body: "## Rule\nbody",
					scope: { files: [], tags: ["test"] },
					source: "explicit",
				});
			} finally {
				lc.close();
			}
			idx
				.rawDb()
				.prepare("UPDATE memories SET pinned = 1 WHERE id = ?")
				.run(idA);
			idx
				.rawDb()
				.prepare("UPDATE memories SET get_count = 50 WHERE id = ?")
				.run(idB);

			const rules = selectWorkflowRules(idx, 10);
			expect(rules[0]?.id).toBe(idA);
			expect(rules[1]?.id).toBe(idB);
			expect(rules[2]?.id).toBe(idC);
		} finally {
			idx.close();
		}
	});
});

describe("formatWorkflowRulesText", () => {
	it("returns empty string for empty rules", () => {
		expect(formatWorkflowRulesText([])).toBe("");
	});

	it("formats non-empty rules with header, bullets, and footer", () => {
		const text = formatWorkflowRulesText([
			{ id: "mem-a", title: "Rule A", type: "decision" },
			{ id: "mem-b", title: "Rule B", type: "how-to" },
		]);
		expect(text).toContain("## Workflow rules — 2 active");
		expect(text).toContain("- [mem-a] Rule A (decision)");
		expect(text).toContain("- [mem-b] Rule B (how-to)");
		expect(text).toContain("Call `get_memory(id)` to consult any rule");
		expect(text).toContain("Surfaced ≠ relevant");
	});
});
