// benchmarks/eval/fixtures/briefing-eval.test.ts
//
// Pre-placed verification test for eval task "briefing-doc-limit".
// Copied into the worktree by the eval harness. Tests that renderKeyDocs
// shows all docs, not just 3.
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { renderBriefing } from "../../../src/lib/briefing.js";

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-04-10T09:30:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test-app", version: "1.0.0", framework: null },
		entryFiles: ["src/index.ts"],
		files: [
			{ path: "src/index.ts", kind: "file" },
			{ path: "docs/a.md", kind: "file" },
			{ path: "docs/b.md", kind: "file" },
			{ path: "docs/c.md", kind: "file" },
			{ path: "docs/d.md", kind: "file" },
			{ path: "docs/e.md", kind: "file" },
		],
		docs: [
			{ path: "docs/a.md", title: "Doc A", body: "# A\n" },
			{ path: "docs/b.md", title: "Doc B", body: "# B\n" },
			{ path: "docs/c.md", title: "Doc C", body: "# C\n" },
			{ path: "docs/d.md", title: "Doc D", body: "# D\n" },
			{ path: "docs/e.md", title: "Doc E", body: "# E\n" },
		],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

describe("briefing-doc-limit eval", () => {
	it("renderKeyDocs shows all 5 docs, not just 3", () => {
		const cache = makeCache();
		const md = renderBriefing(cache);
		for (const doc of cache.docs) {
			expect(md).toContain(doc.path);
		}
	});
});
