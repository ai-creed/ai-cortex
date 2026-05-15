import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	getSink,
	closeAllSinks,
} from "../../../../src/lib/stats/registry.js";

const padded = "726567697374727900".slice(0, 16);
const otherKey = "abcdef0123456789";

let originalCacheHome: string | undefined;
let tmp: string;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stats-registry-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(() => {
	closeAllSinks();
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("getSink", () => {
	it("returns the same handle on repeated calls for the same repoKey", () => {
		const a = getSink(padded);
		const b = getSink(padded);
		expect(a).toBe(b);
	});

	it("returns different handles for different repoKeys", () => {
		const a = getSink(padded);
		const b = getSink(otherKey);
		expect(a).not.toBe(b);
	});
});

describe("closeAllSinks", () => {
	it("closes previously-returned handles", () => {
		const sink = getSink(padded);
		closeAllSinks();
		expect(() => sink.db.prepare("SELECT 1").get()).toThrow();
	});
});
