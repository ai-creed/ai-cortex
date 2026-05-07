import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRetrieve, getMemory } from "../../../../src/lib/memory/retrieve.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { matchMemories, matchMemoriesCrossTier, RANKER_CONFIDENCE_FLOORS } from "../../../../src/lib/memory/surface.js";

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

const PROJECT_BOOST = 0.1;
const FINAL_CAP = 3;

describe("matchMemoriesCrossTier", () => {
	it("merges results from project + global with project boost", async () => {
		const tv = fakeTaskVec();
		const projectId = await seedActiveWithVector([], tv, "project rule");

		// Seed a global-tier memory using the same fake vector.
		setNextVec(tv);
		const globalLc = await openLifecycle("global", { agentId: "test" });
		let globalId: string;
		try {
			globalId = await createMemory(globalLc, {
				type: "decision",
				title: "global rule",
				body: "body",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
		} finally {
			globalLc.close();
		}

		const projectRh = openRetrieve(repoKey);
		const globalRh = openRetrieve("global");
		try {
			const got = await matchMemoriesCrossTier(projectRh, globalRh, {
				mode: "deep",
				topResults: [{ path: "src/anything.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got.map((r) => r.id)).toContain(projectId);
			expect(got.map((r) => r.id)).toContain(globalId);
			// Project-tier memory ranks first due to +0.1 sort-key boost.
			expect(got[0]!.id).toBe(projectId);
			// Wire-format check: matchScores.task is the raw cosine ∈ [0, 1].
			expect(got[0]!.matchScores.task).toBeLessThanOrEqual(1);
			expect(got[0]!.matchScores.task).toBeGreaterThanOrEqual(0);
		} finally {
			projectRh.close();
			globalRh.close();
		}
	});

	it("caps the merged result at 3", async () => {
		const tv = fakeTaskVec();
		// Seed 5 unscoped project memories — all should match.
		for (let i = 0; i < 5; i++) {
			await seedActiveWithVector([], tv, `rule ${i}`);
		}
		const projectRh = openRetrieve(repoKey);
		const globalRh = openRetrieve("global");
		try {
			const got = await matchMemoriesCrossTier(projectRh, globalRh, {
				mode: "deep",
				topResults: [{ path: "src/anything.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got.length).toBeLessThanOrEqual(FINAL_CAP);
		} finally {
			projectRh.close();
			globalRh.close();
		}
	});

	it("survives a global-store failure: returns project results", async () => {
		const tv = fakeTaskVec();
		const id = await seedActiveWithVector([], tv, "project rule");
		const projectRh = openRetrieve(repoKey);
		// Build a stub globalRh whose internal calls throw.
		const brokenGlobalRh = {
			repoKey: "global",
			index: {
				scopeRows: () => {
					throw new Error("boom");
				},
				rawDb: () => {
					throw new Error("boom");
				},
			},
			close: () => {},
		} as unknown as Parameters<typeof matchMemoriesCrossTier>[1];
		try {
			const got = await matchMemoriesCrossTier(projectRh, brokenGlobalRh, {
				mode: "deep",
				topResults: [{ path: "src/x.ts", score: 30 }],
				taskVec: tv,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			projectRh.close();
		}
	});

	it("preserves getCount tiebreak across cross-tier merge", async () => {
		const tv = fakeTaskVec();
		// Two project memories with identical task scores. After cross-tier merge,
		// the one with higher getCount should rank first — even though the per-tier
		// boost makes their _sortKey identical.
		const idA = await seedActiveWithVector([], tv, "alpha");
		const idB = await seedActiveWithVector([], tv, "beta");

		// Bump idB's getCount twice via getMemory.
		const rh1 = openRetrieve(repoKey);
		try {
			await getMemory(rh1, idB);
			await getMemory(rh1, idB);
		} finally {
			rh1.close();
		}

		const projectRh = openRetrieve(repoKey);
		const globalRh = openRetrieve("global");
		try {
			const got = await matchMemoriesCrossTier(projectRh, globalRh, {
				mode: "deep",
				topResults: [{ path: "src/x.ts", score: 30 }],
				taskVec: tv,
			});
			// idB ranks first because of higher getCount, even though both have
			// identical _sortKey (same project boost) and idA < idB alphabetically.
			expect(got[0]!.id).toBe(idB);
		} finally {
			projectRh.close();
			globalRh.close();
		}
	});
});

// ─── Additional cases: L1 gate (fast + semantic modes) ───────────────────────

describe("matchMemories — confidence gate L1 (fast + semantic)", () => {
	it("returns [] when top-1 score is below the fast floor", async () => {
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "fast",
				topResults: [{ path: "src/foo.ts", score: RANKER_CONFIDENCE_FLOORS.fast - 1 }],
				taskVec: fakeTaskVec(),
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});

	it("returns [] when top-1 score is below the semantic floor", async () => {
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "semantic",
				topResults: [{ path: "src/foo.ts", score: RANKER_CONFIDENCE_FLOORS.semantic - 0.01 }],
				taskVec: fakeTaskVec(),
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

// ─── Additional cases: L2 file window (cluster + cap) ────────────────────────

describe("matchMemories — file window (L2) cluster + cap", () => {
	it("uses all top-3 when scores cluster within 70% of top-1", async () => {
		// Seed a scoped memory whose pattern only matches the 3rd-ranked file.
		// If the window correctly includes top-3, the memory surfaces.
		// If the window incorrectly drops to top-1, the memory is rejected.
		const tv = fakeTaskVec();
		const id = await seedActiveWithVector(["src/c.ts"], tv, "third-rank rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [
					{ path: "src/a.ts", score: 30 },
					{ path: "src/b.ts", score: 28 }, // 28/30 = 93% — within 70% cutoff
					{ path: "src/c.ts", score: 27 }, // 27/30 = 90% — within 70% cutoff
				],
				taskVec: tv,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});

	it("caps the window at 3 even when 4+ files are within 70% of top-1", async () => {
		// Seed a memory whose pattern matches only the 4th-ranked file.
		// If cap correctly limits to 3, the memory does NOT surface.
		const tv = fakeTaskVec();
		await seedActiveWithVector(["src/d.ts"], tv, "fourth-rank rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [
					{ path: "src/a.ts", score: 30 },
					{ path: "src/b.ts", score: 29 },
					{ path: "src/c.ts", score: 28 },
					{ path: "src/d.ts", score: 27 }, // would be in 70% range, but cap-3 wins
				],
				taskVec: tv,
			});
			expect(got).toEqual([]);
		} finally {
			rh.close();
		}
	});
});

// ─── Status filter: candidate excluded ───────────────────────────────────────

describe("matchMemories — status filter", () => {
	it("excludes candidate-status memories from results", async () => {
		const tv = fakeTaskVec();
		setNextVec(tv);
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			// source: "extracted" produces a candidate-status memory; "explicit" produces active.
			await createMemory(lc, {
				type: "decision",
				title: "candidate rule",
				body: "body",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
		} finally {
			lc.close();
		}
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

// ─── getCount tiebreak ────────────────────────────────────────────────────────

describe("matchMemories — getCount tiebreak", () => {
	it("orders ties by getCount desc when task scores match", async () => {
		// Seed two memories with identical task scores. Bump idB's getCount via
		// getMemory (which calls rh.index.bumpGetCount internally). The bumped
		// memory should sort first despite alphabetic id ordering preferring idA.
		const tv = fakeTaskVec();
		const idA = await seedActiveWithVector([], tv, "alpha");
		const idB = await seedActiveWithVector([], tv, "beta");

		// Bump idB's getCount by calling getMemory once.
		const rhBump = openRetrieve(repoKey);
		try {
			await getMemory(rhBump, idB);
		} finally {
			rhBump.close();
		}

		const rh = openRetrieve(repoKey);
		try {
			const got = await matchMemories(rh, {
				mode: "deep",
				topResults: [{ path: "src/x.ts", score: 30 }],
				taskVec: tv,
			});
			// idB should rank first because of higher getCount, even though
			// alphabetic id ordering would prefer idA.
			expect(got[0]!.id).toBe(idB);
			// idA still appears somewhere in results.
			expect(got.map((r) => r.id)).toContain(idA);
		} finally {
			rh.close();
		}
	});
});
