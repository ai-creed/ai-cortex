// benchmarks/smoke.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
);

// The perf suite calls clearCache() which deletes the cache dir for whatever
// repo it indexes. Running against the user's real ai-cortex cache home would
// wipe production memory + history. Always run the bench against an isolated
// AI_CORTEX_CACHE_HOME so the destructive path is sandboxed.
let cacheHome: string;

beforeEach(() => {
	cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-bench-smoke-"));
});

afterEach(() => {
	fs.rmSync(cacheHome, { recursive: true, force: true });
});

describe("bench smoke test", () => {
	it("quality suite runs and exits 0", { timeout: 120_000 }, () => {
		const result = spawnSync(
			"npx",
			["tsx", "benchmarks/runner.ts", "--suite", "quality"],
			{
				cwd: ROOT,
				encoding: "utf8",
				timeout: 60000,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, AI_CORTEX_CACHE_HOME: cacheHome },
			},
		);
		const output = result.stdout + result.stderr;
		expect(output).toContain("Quality");
	});

	it(
		"perf suite runs on self-repo only with --fast",
		{ timeout: 120_000 },
		() => {
			const result = spawnSync(
				"npx",
				[
					"tsx",
					"benchmarks/runner.ts",
					"--suite",
					"perf",
					"--repo",
					"ai-cortex",
					"--fast",
				],
				{
					cwd: ROOT,
					encoding: "utf8",
					timeout: 60000,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, AI_CORTEX_CACHE_HOME: cacheHome },
				},
			);
			const output = result.stdout + result.stderr;
			expect(output).toContain("Performance");
			expect(output).toContain("ai-cortex");
		},
	);
});
