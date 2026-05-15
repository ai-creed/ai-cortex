import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("ai-cortex stats CLI", () => {
	it("renders and exits cleanly with --once", () => {
		const cli = path.resolve(__dirname, "../../src/cli.ts");
		const result = spawnSync(
			"pnpm",
			["tsx", cli, "stats", "--once", "--window", "7d"],
			{ encoding: "utf8", timeout: 15_000 },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/ai-cortex stats/);
	});

	it("rejects an invalid --window", () => {
		const cli = path.resolve(__dirname, "../../src/cli.ts");
		const result = spawnSync(
			"pnpm",
			["tsx", cli, "stats", "--window", "bogus", "--once"],
			{ encoding: "utf8", timeout: 5_000 },
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/bad --window/);
	});
});
