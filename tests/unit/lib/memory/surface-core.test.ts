import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { openRetrieve } from "../../../../src/lib/memory/retrieve.js";
import { matchSurfaceMemories } from "../../../../src/lib/memory/surface-core.js";
import { getGenericTags } from "../../../../src/lib/memory/retrieve.js";

let repoKey: string;
beforeEach(async () => { repoKey = await mkRepoKey("surface-core"); });
afterEach(async () => { await cleanupRepo(repoKey); });

async function add(
	scopeFiles: string[],
	title: string,
	type = "decision",
): Promise<string> {
	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		return await createMemory(lc, {
			type,
			title,
			body: `## ${title}\nrule body`,
			scope: { files: scopeFiles, tags: [] },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
}

describe("matchSurfaceMemories", () => {
	it("matches a literal file scope", async () => {
		const id = await add(["src/lib/memory/store.ts"], "store rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(rh, ["src/lib/memory/store.ts"]);
			expect(got.map((p) => p.id)).toEqual([id]);
			expect(got[0]!.title).toBe("store rule");
		} finally {
			rh.close();
		}
	});

	it("matches a glob file scope against a new path", async () => {
		const id = await add(["src/lib/memory/*.ts"], "glob rule");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(rh, ["src/lib/memory/brand-new.ts"]);
			expect(got.map((p) => p.id)).toEqual([id]);
		} finally {
			rh.close();
		}
	});

	it("excludes unscoped and tag-only memories", async () => {
		await add([], "unscoped rule"); // scope.files = [] → excluded
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "tag-only rule",
				body: "## tag\nx",
				scope: { files: [], tags: ["memory-surfacing"] }, // tag-only → excluded
				source: "explicit",
			});
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			expect(matchSurfaceMemories(rh, ["src/lib/memory/store.ts"])).toEqual([]);
		} finally {
			rh.close();
		}
	});

	it("literal scope outranks a broad glob regardless of order", async () => {
		await add(["src/**/*.ts"], "broad glob");
		const exact = await add(["src/lib/memory/store.ts"], "exact");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(rh, ["src/lib/memory/store.ts"]);
			expect(got[0]!.id).toBe(exact);
		} finally {
			rh.close();
		}
	});

	it("caps at 5", async () => {
		for (let i = 0; i < 7; i++) await add(["src/a.ts"], `r${i}`);
		const rh = openRetrieve(repoKey);
		try {
			expect(matchSurfaceMemories(rh, ["src/a.ts"]).length).toBe(5);
		} finally {
			rh.close();
		}
	});

	it("only active memories surface", async () => {
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let id: string;
		try {
			id = await createMemory(lc, {
				type: "decision",
				title: "cand",
				body: "## cand\nx",
				scope: { files: ["src/a.ts"], tags: [] },
				source: "extracted", // extracted → status 'candidate'
			});
		} finally {
			lc.close();
		}
		const rh = openRetrieve(repoKey);
		try {
			expect(matchSurfaceMemories(rh, ["src/a.ts"]).map((p) => p.id)).not.toContain(id);
		} finally {
			rh.close();
		}
	});
});

async function addTagOnly(scopeTags: string[], title: string): Promise<string> {
	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		return await createMemory(lc, {
			type: "decision",
			title,
			body: `## ${title}\nrule body`,
			scope: { files: [], tags: scopeTags },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
}

async function addMixed(
	scopeFiles: string[],
	scopeTags: string[],
	title: string,
): Promise<string> {
	const lc = await openLifecycle(repoKey, { agentId: "test" });
	try {
		return await createMemory(lc, {
			type: "decision",
			title,
			body: `## ${title}\nrule body`,
			scope: { files: scopeFiles, tags: scopeTags },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
}

describe("matchSurfaceMemories Tier 2", () => {
	it("Tier 2 is OFF by default — tag-only memories never surface without opts.tier2", async () => {
		await addTagOnly(["unit-tests"], "tag-only");
		const rh = openRetrieve(repoKey);
		try {
			expect(
				matchSurfaceMemories(rh, ["Services/foo.app-test.ts"]),
			).toEqual([]);
		} finally {
			rh.close();
		}
	});

	it("Tier 2 surfaces tag-only memory on path-token / tag-token overlap when opts.tier2 = true", async () => {
		const id = await addTagOnly(["unit-tests"], "use strictEqual");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			expect(got.map((p) => p.id)).toContain(id);
			expect(got.find((p) => p.id === id)?.tier).toBe("tag");
		} finally {
			rh.close();
		}
	});

	it("Tier 1 always ranks above Tier 2 (file-scope-matched memory comes first)", async () => {
		await addTagOnly(["app", "test"], "tag-only first?");
		const fileId = await add(["**/*.app-test.ts"], "file-scope first");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			expect(got[0]?.id).toBe(fileId);
			expect(got[0]?.tier).toBe("file");
		} finally {
			rh.close();
		}
	});

	it("mixed-scope memory: file-scope matches → Tier 1 ONLY, NOT double-counted in Tier 2", async () => {
		const id = await addMixed(["**/*.app-test.ts"], ["test"], "mixed both");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			const occurrences = got.filter((p) => p.id === id);
			expect(occurrences).toHaveLength(1);
			expect(occurrences[0]?.tier).toBe("file");
		} finally {
			rh.close();
		}
	});

	it("mixed-scope memory: file-scope does NOT match this path but tags overlap → Tier 2 fallthrough", async () => {
		const id = await addMixed(
			["MainApp/**/*.ts"],
			["app", "test"],
			"mixed scope, file misses, tags hit",
		);
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			expect(got.map((p) => p.id)).toContain(id);
			expect(got.find((p) => p.id === id)?.tier).toBe("tag");
		} finally {
			rh.close();
		}
	});

	it("CAP=5: Tier 1 returns 2, Tier 2 fills up to 3 more", async () => {
		await add(["**/*.app-test.ts"], "file-1");
		await add(["Services/**/*.ts"], "file-2");
		for (let i = 0; i < 5; i++) {
			await addTagOnly(["app", "test"], `tag-${i}`);
		}
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			expect(got).toHaveLength(5);
			expect(got.filter((p) => p.tier === "file")).toHaveLength(2);
			expect(got.filter((p) => p.tier === "tag")).toHaveLength(3);
		} finally {
			rh.close();
		}
	});

	it("CAP=5: Tier 1 returns 0, Tier 2 fills up to 5 (capped, not 8)", async () => {
		for (let i = 0; i < 8; i++) {
			await addTagOnly(["app", "test"], `tag-${i}`);
		}
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			expect(got).toHaveLength(5);
			expect(got.every((p) => p.tier === "tag")).toBe(true);
		} finally {
			rh.close();
		}
	});

	it("empty Tier 2 candidate pool yields Tier-1-only result unchanged", async () => {
		const fileId = await add(["**/*.app-test.ts"], "file-only");
		const rh = openRetrieve(repoKey);
		try {
			const got = matchSurfaceMemories(
				rh,
				["Services/foo.app-test.ts"],
				{ tier2: true },
			);
			expect(got.map((p) => p.id)).toEqual([fileId]);
			expect(got[0]?.tier).toBe("file");
		} finally {
			rh.close();
		}
	});
});

describe("getGenericTags + Tier-2 threshold", () => {
	it("getGenericTags returns only tags at or above minCount", async () => {
		await addTagOnly(["common"], "a");
		await addTagOnly(["common"], "b");
		await addTagOnly(["rare"], "c");
		const rh = openRetrieve(repoKey);
		try {
			const generic = getGenericTags(rh, 2);
			expect(generic.has("common")).toBe(true);
			expect(generic.has("rare")).toBe(false);
		} finally { rh.close(); }
	});

	it("Tier 2 drops a score-1 overlap when tier2MinScore = 2", async () => {
		const id = await addTagOnly(["unit-tests"], "single token");
		const rh = openRetrieve(repoKey);
		try {
			const path = ["Services/foo.app-test.ts"]; // overlaps on {test} → score 1
			const lo = matchSurfaceMemories(rh, path, { tier2: true });
			const hi = matchSurfaceMemories(rh, path, { tier2: true, tier2MinScore: 2 });
			expect(lo.some((p) => p.id === id)).toBe(true);
			expect(hi.some((p) => p.id === id)).toBe(false);
		} finally { rh.close(); }
	});

	it("Tier 2 excludes a generic-tag-only overlap at the matcher layer", async () => {
		// Make "common" generic: it must appear in >= GENERIC_TAG_MIN_COUNT (9)
		// active memories for matchSurfaceMemories to treat it as non-discriminating.
		for (let i = 0; i < 9; i++) await addTagOnly(["common"], `seed ${i}`);
		const genericOnly = await addTagOnly(["common"], "generic-only target");
		const specific = await addTagOnly(["widget"], "specific target");
		const rh = openRetrieve(repoKey);
		try {
			// Path tokens include both "common" (generic) and "widget" (non-generic).
			const got = matchSurfaceMemories(rh, ["src/common/widget-helper.ts"], { tier2: true });
			const ids = got.map((p) => p.id);
			// Proves matchSurfaceMemories threads the generic set into tagOverlapScore:
			expect(ids).not.toContain(genericOnly); // generic-tag-only overlap excluded
			expect(ids).toContain(specific); // non-generic overlap still surfaces
		} finally { rh.close(); }
	});
});
