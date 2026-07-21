import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
	DEFAULT_CONFIG,
	loadMemoryConfig,
} from "../../../../src/lib/memory/config.js";
import { memoryRootDir } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("intake config", () => {
	let repoKey: string;
	afterEach(async () => {
		if (repoKey) await cleanupRepo(repoKey);
	});

	it("defaults: intakeTierRouting on, tmp prefixes ignored, autoSweep on", () => {
		expect(DEFAULT_CONFIG.intakeTierRouting).toBe(true);
		expect(DEFAULT_CONFIG.ignoreWorktreePrefixes).toEqual([
			"/tmp/",
			"/private/tmp/",
		]);
		expect(DEFAULT_CONFIG.aging.autoSweep).toBe(true);
	});

	it("repo config.json can disable intakeTierRouting and autoSweep", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const root = memoryRootDir(repoKey);
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(
			path.join(root, "config.json"),
			JSON.stringify({
				memory: {
					intakeTierRouting: false,
					aging: { autoSweep: false },
				},
			}),
		);
		const cfg = await loadMemoryConfig(repoKey);
		expect(cfg.intakeTierRouting).toBe(false);
		expect(cfg.aging.autoSweep).toBe(false);
		// untouched sibling defaults survive the deep merge
		expect(cfg.ignoreWorktreePrefixes).toEqual(["/tmp/", "/private/tmp/"]);
		expect(cfg.aging.trashedToPurgedDays).toBe(90);
	});
});
