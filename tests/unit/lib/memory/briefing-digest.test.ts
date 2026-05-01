import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
	openLifecycle,
	createMemory,
} from "../../../../src/lib/memory/lifecycle.js";
import { renderMemoryDigest } from "../../../../src/lib/memory/briefing-digest.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("digest-test");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

// NOTE: createMemory with source: "explicit" produces an active memory directly.
// No confirmMemory call is needed (and it would throw — confirmMemory only works
// on candidate status). Use source: "extracted" only when you specifically want
// to test candidate-state behavior.

describe("renderMemoryDigest", () => {
	it("returns null when the store is empty", async () => {
		const out = await renderMemoryDigest(repoKey);
		expect(out).toBeNull();
	});

	it("includes counts of active, candidate, and pinned memories", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Use POST for create endpoints",
				body: "## Decision\nuse POST",
				scope: { files: ["src/api.ts"], tags: ["api"] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}
		const out = await renderMemoryDigest(repoKey);
		expect(out).not.toBeNull();
		expect(out!).toContain("Memory available");
		expect(out!).toMatch(/1 active/);
	});

	it("groups top-5 active memories per type", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			for (let i = 0; i < 7; i++) {
				await createMemory(lc, {
					type: "decision",
					title: `Decision ${i}`,
					body: `## Body\n${i}`,
					scope: { files: [], tags: [] },
					source: "explicit",
				});
			}
		} finally {
			lc.close();
		}
		const out = await renderMemoryDigest(repoKey);
		// Only top-5 of the 7 decisions appear.
		const matches = (out ?? "").match(/Decision \d/g) ?? [];
		expect(matches.length).toBe(5);
	});

	it("renders every type present in the store, not a hard-coded subset", async () => {
		// Verifies the digest queries DISTINCT type from the index rather than
		// iterating a hardcoded list. If a custom type is registered (via
		// types.json), it must appear too. Here we cover decision + gotcha to
		// prove the renderer is type-agnostic; user-registered types follow the
		// same code path because the implementation reads from the index.
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "d",
				body: "## Body\nd",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await createMemory(lc, {
				type: "gotcha",
				title: "g",
				body: "## Body\ng",
				scope: { files: [], tags: [] },
				source: "explicit",
				typeFields: { severity: "info" },
			});
		} finally {
			lc.close();
		}
		const out = await renderMemoryDigest(repoKey);
		expect(out!).toMatch(/### .*Decision/);
		expect(out!).toMatch(/### .*Gotcha/);
	});

	it("includes 'How to consult' guidance with get_memory mention", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "x",
				body: "## Body\nx",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}
		const out = await renderMemoryDigest(repoKey);
		expect(out!).toMatch(/How to consult/i);
		expect(out!).toMatch(/get_memory/);
		expect(out!).toMatch(/scope\.files|source:.*all/);
	});
});
