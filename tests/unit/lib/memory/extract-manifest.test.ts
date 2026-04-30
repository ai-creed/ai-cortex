import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import {
	writeManifest,
	readManifest,
} from "../../../../src/lib/memory/extract.js";
import { extractorRunPath } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("extract — manifest io", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("manifest");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("writes a manifest at the expected path and reads it back unchanged", async () => {
		const m = {
			version: 1 as const,
			sessionId: "s-x",
			runAt: "2026-04-30T10:14:00Z",
			lastProcessedTurn: 47,
			candidatesCreated: 1,
			evidenceAppended: 2,
			rejectedCandidates: [
				{
					type: "decision" as const,
					reason: "below floor",
					previewText: "preview",
				},
			],
			createdMemoryIds: ["mem-a"],
			appendedToMemoryIds: ["mem-b", "mem-c"],
		};
		await writeManifest(repoKey, "s-x", m);
		const filePath = extractorRunPath(repoKey, "s-x");
		const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
		expect(onDisk).toEqual(m);
		expect(await readManifest(repoKey, "s-x")).toEqual(m);
	});

	it("returns null when no manifest exists", async () => {
		expect(await readManifest(repoKey, "missing")).toBeNull();
	});
});
