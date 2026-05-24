import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import { appendSurfaceEvent } from "../../src/lib/stats/surface-events.js";
import { getCacheDir } from "../../src/lib/cache-store.js";

let repoKey: string;
beforeEach(async () => {
	repoKey = await mkRepoKey("telemetry-shape");
});
afterEach(async () => {
	await cleanupRepo(repoKey);
});

function readEvents(repoKey: string): unknown[] {
	const dir = getCacheDir(repoKey);
	const file = path.join(dir, "adoption", "surface-events.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

describe("surface-events telemetry shape", () => {
	it("writes tiers as an array parallel to memoryIds (mixed tier event)", () => {
		appendSurfaceEvent(repoKey, {
			ts: 1000,
			session_id: "test-sess",
			memoryIds: ["mem-a", "mem-b", "mem-c"],
			tiers: ["file", "file", "tag"],
			count: 3,
		});
		const events = readEvents(repoKey);
		expect(events).toHaveLength(1);
		const e = events[0] as Record<string, unknown>;
		expect(Array.isArray(e.tiers)).toBe(true);
		expect(e.tiers).toEqual(["file", "file", "tag"]);
		expect((e.tiers as unknown[]).length).toEqual(
			(e.memoryIds as unknown[]).length,
		);
	});

	it("accepts events without tiers (back-compat)", () => {
		appendSurfaceEvent(repoKey, {
			ts: 2000,
			session_id: null,
			memoryIds: ["mem-x"],
			count: 1,
		});
		const events = readEvents(repoKey);
		expect(events).toHaveLength(1);
		const e = events[0] as Record<string, unknown>;
		expect(e.memoryIds).toEqual(["mem-x"]);
	});
});
