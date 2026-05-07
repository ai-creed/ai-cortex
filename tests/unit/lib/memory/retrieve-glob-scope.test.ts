import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRetrieve, filterCandidates } from "../../../../src/lib/memory/retrieve.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";

vi.mock("../../../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(async () => ({
		embed: async (texts: string[]) => texts.map(() => new Float32Array(384)),
	})),
}));

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-glob-scope-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fs.rm(tmp, { recursive: true, force: true });
});

const repoKey = "0123456789abcdef";

async function seedActive(scopeFiles: string[], title = "rule"): Promise<string> {
	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		return await createMemory(lc, {
			type: "decision",
			title,
			body: "test body",
			scope: { files: scopeFiles, tags: [] },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
}

describe("filterCandidates SQL pre-filter — glob admission", () => {
	it("admits literal-scope memory when caller passes the same literal", async () => {
		const id = await seedActive(["src/foo.ts"]);
		const rh = openRetrieve(repoKey);
		try {
			const got = filterCandidates(rh, {
				scope: { files: ["src/foo.ts"], tags: [] },
				candidatePoolSize: 100,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});

	it("admits glob-scope memory regardless of caller's literal path", async () => {
		const id = await seedActive(["MainApp/**/*card*"]);
		const rh = openRetrieve(repoKey);
		try {
			const got = filterCandidates(rh, {
				scope: { files: ["MainApp/lib/cards/card.ts"], tags: [] },
				candidatePoolSize: 100,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});

	it("admits unscoped memory even when caller passes a scope filter", async () => {
		const id = await seedActive([]);
		const rh = openRetrieve(repoKey);
		try {
			const got = filterCandidates(rh, {
				scope: { files: ["src/foo.ts"], tags: [] },
				candidatePoolSize: 100,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});
});

import { recallMemory } from "../../../../src/lib/memory/retrieve.js";

describe("recallMemory — scoring with glob-scoped memory", () => {
	it("scores glob-scope hit at scopeMatch=1.0 when caller's literal path matches the glob", async () => {
		const id = await seedActive(["MainApp/**/*card*"], "card rule");
		const rh = openRetrieve(repoKey);
		try {
			const results = await recallMemory(rh, "card", {
				scope: { files: ["MainApp/lib/cards/card.ts"], tags: [] },
				limit: 10,
			});
			const hit = results.find((r) => r.id === id);
			expect(hit).toBeDefined();
			// scopeMatch=1.0 dominates over the unscoped 0.2 default; if the scoring
			// fix didn't fire, the result would have scope contribution 0 and the
			// hit might not appear at all.
			// 0.3*1.0 + 0.1*1.0 + 0.05*1.0 + 0.05*1.0 ≈ 0.5; well above the
			// unfixed 0.2 (unscoped default) — use 0.45 to avoid float-rounding edge.
			expect(hit!.score).toBeGreaterThan(0.45);
		} finally {
			rh.close();
		}
	});
});
