import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	findDedupTarget,
	type DedupCandidate,
} from "../../../../src/lib/memory/extract.js";
import {
	openLifecycle,
	createMemory,
} from "../../../../src/lib/memory/lifecycle.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("extract — findDedupTarget", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("dedup");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("finds an existing same-type candidate above the cosine threshold with tag overlap", async () => {
		const lc = await openLifecycle(repoKey);
		const existingId = await createMemory(lc, {
			type: "decision",
			title: "Always use POST for create",
			body: "All create endpoints accept POST only — never GET.",
			scope: { files: [], tags: ["http", "api"] },
			source: "extracted",
		});
		const candidate: DedupCandidate = {
			type: "decision",
			title: "Use POST for resource creation",
			body: "Create endpoints take POST not GET.",
			tags: ["http"],
		};
		const hit = await findDedupTarget(lc, candidate, { dedupCosine: 0.7 });
		expect(hit).toBe(existingId);
		lc.close();
	});

	it("returns null when type mismatches even with high cosine", async () => {
		const lc = await openLifecycle(repoKey);
		await createMemory(lc, {
			type: "gotcha",
			title: "Always use POST for create",
			body: "All create endpoints accept POST only — never GET.",
			scope: { files: [], tags: ["http"] },
			source: "extracted",
			typeFields: { severity: "warning" },
		});
		const hit = await findDedupTarget(
			lc,
			{
				type: "decision",
				title: "Use POST for create",
				body: "Create endpoints take POST.",
				tags: ["http"],
			},
			{ dedupCosine: 0.7 },
		);
		expect(hit).toBeNull();
		lc.close();
	});

	it("returns null when tag intersection is empty", async () => {
		const lc = await openLifecycle(repoKey);
		await createMemory(lc, {
			type: "decision",
			title: "Always use POST for create",
			body: "All create endpoints accept POST only.",
			scope: { files: [], tags: ["http"] },
			source: "extracted",
		});
		const hit = await findDedupTarget(
			lc,
			{
				type: "decision",
				title: "POST for create",
				body: "Create takes POST.",
				tags: ["unrelated"],
			},
			{ dedupCosine: 0.7 },
		);
		expect(hit).toBeNull();
		lc.close();
	});

	it("returns null when cosine is below threshold", async () => {
		const lc = await openLifecycle(repoKey);
		await createMemory(lc, {
			type: "decision",
			title: "Always use POST for create",
			body: "All create endpoints accept POST only — never GET.",
			scope: { files: [], tags: ["http"] },
			source: "extracted",
		});
		const hit = await findDedupTarget(
			lc,
			{
				type: "decision",
				title: "Frobnicate the widget",
				body: "Widgets must be frobnicated.",
				tags: ["http"],
			},
			{ dedupCosine: 0.95 },
		);
		expect(hit).toBeNull();
		lc.close();
	});

	it("returns null when the candidate has no tags (empty intersection short-circuit)", async () => {
		const lc = await openLifecycle(repoKey);
		await createMemory(lc, {
			type: "decision",
			title: "Always use POST for create",
			body: "All create endpoints accept POST only — never GET.",
			scope: { files: [], tags: ["http"] },
			source: "extracted",
		});
		const hit = await findDedupTarget(
			lc,
			{
				type: "decision",
				title: "Use POST for create",
				body: "Create endpoints take POST.",
				tags: [],
			},
			{ dedupCosine: 0.7 },
		);
		expect(hit).toBeNull();
		lc.close();
	});
});
