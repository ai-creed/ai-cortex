import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_CONFIG,
	loadMemoryConfig,
} from "../../../../src/lib/memory/config.js";
import { memoryRootDir } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("intake config", () => {
	let repoKey: string;
	let home: string;

	// loadMemoryConfig merges ~/.config/ai-cortex/config.json; point homedir at
	// an empty tmp dir so the developer's real user config cannot leak in.
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-intake-home-"));
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		if (repoKey) await cleanupRepo(repoKey);
		vi.restoreAllMocks();
		await fs.rm(home, { recursive: true, force: true });
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

	it("user config.json contributes to the merge", async () => {
		repoKey = await mkRepoKey("intake-v2-user");
		const userDir = path.join(home, ".config", "ai-cortex");
		await fs.mkdir(userDir, { recursive: true });
		await fs.writeFile(
			path.join(userDir, "config.json"),
			JSON.stringify({ memory: { ignoreWorktreePrefixes: ["/scratch/"] } }),
		);
		const cfg = await loadMemoryConfig(repoKey);
		expect(cfg.ignoreWorktreePrefixes).toEqual(["/scratch/"]);
		expect(cfg.intakeTierRouting).toBe(true);
	});
});
