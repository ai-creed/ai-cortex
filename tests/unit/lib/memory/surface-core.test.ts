import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { openRetrieve } from "../../../../src/lib/memory/retrieve.js";
import { matchSurfaceMemories } from "../../../../src/lib/memory/surface-core.js";

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

	it("caps at 3", async () => {
		for (let i = 0; i < 5; i++) await add(["src/a.ts"], `r${i}`);
		const rh = openRetrieve(repoKey);
		try {
			expect(matchSurfaceMemories(rh, ["src/a.ts"]).length).toBe(3);
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
