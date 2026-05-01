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

	it("renders multiple types present in the store via lifecycle createMemory", async () => {
		// Smoke test that the digest renders one section per type that appears
		// in the store. Two built-in types (decision, gotcha) cover the
		// happy path through createMemory + registry validation.
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

	it("renders user-registered (non-built-in) types via direct SQL — proves the renderer queries DISTINCT type, not a hardcoded list", async () => {
		// Bypass the registry/lifecycle to simulate a future user-registered
		// type. Insert a row directly with type="custom-rule"; the renderer
		// must surface it in its own section because the SQL query is
		// type-agnostic.
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			const db = lc.index.rawDb();
			db.prepare(
				`INSERT INTO memories
				 (id, type, status, title, version, created_at, updated_at,
				  source, confidence, pinned, body_hash, body_excerpt)
				 VALUES (?, ?, 'active', ?, 1, ?, ?, 'explicit', 1.0, 0, '0', '')`,
			).run(
				"mem-custom-1",
				"custom-rule",
				"a custom-rule memory",
				new Date().toISOString(),
				new Date().toISOString(),
			);
		} finally {
			lc.close();
		}
		const out = await renderMemoryDigest(repoKey);
		expect(out!).toMatch(/### .*custom-rule/i);
		expect(out!).toContain("a custom-rule memory");
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
