// benchmarks/smoke.test.ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

describe("bench smoke test", () => {
	it("quality suite runs and exits 0", () => {
		const result = spawnSync(
			"npx",
			["tsx", "benchmarks/runner.ts", "--suite", "quality"],
			{ cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
		);
		const output = result.stdout + result.stderr;
		expect(output).toContain("Quality");
	});

	it("perf suite runs on self-repo only with --fast", () => {
		const result = spawnSync(
			"npx",
			["tsx", "benchmarks/runner.ts", "--suite", "perf", "--repo", "ai-cortex", "--fast"],
			{ cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
		);
		const output = result.stdout + result.stderr;
		expect(output).toContain("Performance");
		expect(output).toContain("ai-cortex");
	});
});
