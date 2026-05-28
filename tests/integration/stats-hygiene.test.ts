import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("E2E: cortex stats --once renders with verdict band + does not crash on empty config", () => {
	let tmp: string;
	beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-int-")); });
	afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

	it("exits 0 with verdict band text on stdout", () => {
		const res = spawnSync("pnpm", ["-s", "cortex", "stats", "--once", "--window", "7d"], {
			env: { ...process.env, AI_CORTEX_CACHE_HOME: tmp, COLUMNS: "120", LINES: "40" },
			encoding: "utf8",
			cwd: process.cwd(),
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("Is ai-cortex helping?");
	});

	it("does not crash with a malformed stats-config.json", () => {
		fs.writeFileSync(path.join(tmp, "stats-config.json"), "{not json");
		const res = spawnSync("pnpm", ["-s", "cortex", "stats", "--once"], {
			env: { ...process.env, AI_CORTEX_CACHE_HOME: tmp, COLUMNS: "120", LINES: "40" },
			encoding: "utf8",
			cwd: process.cwd(),
		});
		expect(res.status).toBe(0);
	});
});
