import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, _resetStorageCacheForTest } from "../../../../src/lib/stats/query.js";
import { cacheRoot, statsConfigPath } from "../../../../src/lib/stats/paths.js";

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";

describe("listProjects filtering", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-list-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(cacheRoot(), { recursive: true });
		for (const k of [A, B, C]) fs.mkdirSync(path.join(cacheRoot(), k));
		fs.mkdirSync(path.join(cacheRoot(), "_archived", "deaddeaddeaddead"), { recursive: true });
		_resetStorageCacheForTest();
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("skips _-prefixed dirs (existing REPO_KEY_RE behavior)", () => {
		expect(listProjects()).toEqual([A, B, C].sort());
	});

	it("skips repoKeys in stats-config.json.excluded", () => {
		fs.writeFileSync(statsConfigPath(), JSON.stringify({ version: 1, excluded: [B] }));
		expect(listProjects()).toEqual([A, C].sort());
	});

	it("composes both filters (excluded + underscore)", () => {
		fs.writeFileSync(statsConfigPath(), JSON.stringify({ version: 1, excluded: [A, C] }));
		expect(listProjects()).toEqual([B]);
	});
});
