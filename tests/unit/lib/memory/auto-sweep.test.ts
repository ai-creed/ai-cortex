// tests/unit/lib/memory/auto-sweep.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { runAutoSweepIfDue } from "../../../../src/lib/memory/auto-sweep.js";
import { memoryRootDir } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("runAutoSweepIfDue", () => {
	let repoKey: string;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (repoKey) await cleanupRepo(repoKey);
	});

	it("runs once, then rate-limits within 24h", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const sweep = vi.fn().mockResolvedValue({ actionsApplied: [], dryRun: false });
		expect(await runAutoSweepIfDue(repoKey, { sweep })).toBe("ran");
		expect(await runAutoSweepIfDue(repoKey, { sweep })).toBe("skipped-recent");
		expect(sweep).toHaveBeenCalledTimes(1);
	});

	it("a stale sentinel (>24h) is due again", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const root = memoryRootDir(repoKey);
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(
			path.join(root, ".last-auto-sweep"),
			new Date(Date.now() - 25 * 3_600_000).toISOString() + "\n",
		);
		const sweep = vi.fn().mockResolvedValue({ actionsApplied: [], dryRun: false });
		expect(await runAutoSweepIfDue(repoKey, { sweep })).toBe("ran");
	});

	it("autoSweep: false disables entirely", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const root = memoryRootDir(repoKey);
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(
			path.join(root, "config.json"),
			JSON.stringify({ memory: { aging: { autoSweep: false } } }),
		);
		const sweep = vi.fn();
		expect(await runAutoSweepIfDue(repoKey, { sweep })).toBe("disabled");
		expect(sweep).not.toHaveBeenCalled();
	});

	it("a sweep failure is swallowed with stderr, and still rate-limits", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const sweep = vi.fn().mockRejectedValue(new Error("sweep exploded"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runAutoSweepIfDue(repoKey, { sweep })).toBe("ran");
		expect(errSpy).toHaveBeenCalled();
		expect(await runAutoSweepIfDue(repoKey, { sweep })).toBe("skipped-recent");
	});
});
