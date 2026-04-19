// tests/integration/semantic.test.ts
// Integration tests for semantic ranking.
// Requires AI_CORTEX_SEMANTIC_INTEGRATION=1 to run (downloads ~23 MB model).
// Note: sidecar (.vectors.bin + .vectors.meta.json) is intentionally left in
// ~/.cache/ai-cortex/v1/<worktreeKey>/ after the suite — test 6 depends on
// the cached vectors, and subsequent CI runs reuse them as expected.
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { suggestRepo } from "../../src/lib/suggest.js";
import type { SemanticSuggestResult } from "../../src/lib/suggest.js";

const RUN_SEMANTIC = process.env["AI_CORTEX_SEMANTIC_INTEGRATION"] === "1";
const THIS_REPO = path.resolve(import.meta.dirname, "../..");

describe.skipIf(!RUN_SEMANTIC)("semantic integration (requires AI_CORTEX_SEMANTIC_INTEGRATION=1)", () => {
	let result: SemanticSuggestResult;

	beforeAll(async () => {
		// First call builds the sidecar — may take 30–60 s on cold start
		const r = await suggestRepo(THIS_REPO, "embedding model and vector index", {
			mode: "semantic",
			limit: 5,
		});
		if (r.mode !== "semantic") throw new Error(`unexpected mode: ${r.mode}`);
		result = r;
	}, 120_000); // 2-minute timeout for model download + embed

	it("returns SemanticSuggestResult with mode='semantic'", () => {
		expect(result.mode).toBe("semantic");
	});

	it("returns at least 1 result", () => {
		expect(result.results.length).toBeGreaterThan(0);
	});

	it("all results have valid structure", () => {
		for (const r of result.results) {
			expect(r.path).toBeTypeOf("string");
			expect(["file", "doc"]).toContain(r.kind);
			expect(r.score).toBeTypeOf("number");
			expect(r.score).toBeGreaterThan(-1);
			expect(r.score).toBeLessThanOrEqual(1);
			expect(r.reason).toMatch(/^semantic similarity:/);
		}
	});

	it("results are sorted by score descending", () => {
		for (let i = 1; i < result.results.length; i++) {
			expect(result.results[i - 1]!.score).toBeGreaterThanOrEqual(result.results[i]!.score);
		}
	});

	it("poolSize equals total file count in repo index", () => {
		expect(result.poolSize).toBeGreaterThan(0);
	});

	it("second call with stale:true is faster (uses cached sidecar)", async () => {
		const t0 = Date.now();
		const r2 = await suggestRepo(THIS_REPO, "embedding model and vector index", {
			mode: "semantic",
			limit: 5,
			stale: true,
		});
		const elapsed = Date.now() - t0;
		if (r2.mode !== "semantic") throw new Error(`unexpected mode: ${r2.mode}`);
		// Should complete quickly since sidecar already exists
		expect(elapsed).toBeLessThan(30_000);
	}, 60_000);
});
