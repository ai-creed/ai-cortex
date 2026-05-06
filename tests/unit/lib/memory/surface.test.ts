import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRetrieve } from "../../../../src/lib/memory/retrieve.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { matchMemories, RANKER_CONFIDENCE_FLOORS } from "../../../../src/lib/memory/surface.js";

// Deterministic embedder.
let nextVec: Float32Array | null = null;
function setNextVec(v: Float32Array): void {
	nextVec = v;
}

vi.mock("../../../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(async () => ({
		embed: async (texts: string[]) => {
			const v = nextVec ?? new Float32Array(384);
			return texts.map(() => v);
		},
	})),
}));

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-surface-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	nextVec = null;
});

afterEach(async () => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	await fs.rm(tmp, { recursive: true, force: true });
});

const repoKey = "0123456789abcdef";

function fakeTaskVec(): Float32Array {
	const v = new Float32Array(384);
	for (let i = 0; i < 384; i++) v[i] = (i % 7) / 7;
	return v;
}

async function seedActiveWithVector(
	scopeFiles: string[],
	memoryVec: Float32Array,
	title: string,
): Promise<string> {
	setNextVec(memoryVec);
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

describe("matchMemories — confidence gate L1", () => {
	it("returns [] when top-1 score is below the deep floor", async () => {
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/foo.ts", score: RANKER_CONFIDENCE_FLOORS.deep - 1 }],
				taskVec: fakeTaskVec(),
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

describe("matchMemories — file window (L2)", () => {
	it("uses only top-1 when top-2 score is below 70% of top-1", async () => {
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [
					{ path: "src/a.ts", score: 30 },
					{ path: "src/b.ts", score: 10 },
				],
				taskVec: fakeTaskVec(),
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

describe("matchMemories — scoped track via glob", () => {
	it("matches glob-scoped memory when window file matches the glob", async () => {
		const tv = fakeTaskVec();
		const id = await seedActiveWithVector(["MainApp/**/*card*"], tv, "card rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "MainApp/lib/cards/card.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got.map((r) => r.id)).toContain(id);
			const hit = got.find((r) => r.id === id)!;
			expect(hit.track).toBe("scoped");
			// fileOverlap holds the matched WINDOW path, not the stored pattern.
			expect(hit.matchScores.fileOverlap).toContain("MainApp/lib/cards/card.ts");
		} finally {
			rh.close();
		}
	});

	it("rejects scoped memory when window has no overlap", async () => {
		const tv = fakeTaskVec();
		await seedActiveWithVector(["src/foo.ts"], tv, "foo rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "MainApp/cards/card.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

describe("matchMemories — unscoped track stricter threshold", () => {
	it("admits unscoped memory above 0.6", async () => {
		const tv = fakeTaskVec();
		const id = await seedActiveWithVector([], tv, "global rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/anything.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got.map((r) => r.id)).toContain(id);
			expect(got.find((r) => r.id === id)!.track).toBe("unscoped");
		} finally {
			rh.close();
		}
	});

	it("rejects unscoped memory whose vector cosines below 0.6", async () => {
		const tv = fakeTaskVec();
		const orthogonal = new Float32Array(384);
		orthogonal[0] = 1;
		await seedActiveWithVector([], orthogonal, "unrelated rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/foo.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

describe("matchMemories — sort + tiebreak", () => {
	it("sorts by task score descending, ties by id asc", async () => {
		const tv = fakeTaskVec();
		await seedActiveWithVector([], tv, "alpha");
		await seedActiveWithVector([], tv, "beta");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/x.ts", score: 30 }],
				taskVec: tv,
			});
			const ids = got.map((r) => r.id);
			expect(ids).toEqual(ids.slice().sort());
		} finally {
			rh.close();
		}
	});
});

describe("matchMemories — empty store", () => {
	it("returns [] when no memories exist", async () => {
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/foo.ts", score: 30 }],
				taskVec: fakeTaskVec(),
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

describe("matchMemories — vector missing", () => {
	it("skips memory whose vector sidecar was deleted", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "rule",
				body: "body",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}
		// Wipe the vector sidecar.
		const sidecarBin = path.join(tmp, repoKey, "memory", ".vectors.bin");
		const sidecarMeta = path.join(tmp, repoKey, "memory", ".vectors.meta.json");
		await fs.rm(sidecarBin, { force: true });
		await fs.rm(sidecarMeta, { force: true });

		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/foo.ts", score: 30 }],
				taskVec: fakeTaskVec(),
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});
