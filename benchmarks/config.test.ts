// benchmarks/config.test.ts
import { describe, it, expect } from "vitest";
import { discoverRepos, getSloForScenario, getConfig } from "./config.js";

describe("discoverRepos", () => {
	it("always includes self repo", () => {
		const repos = discoverRepos();
		const self = repos.find((r) => r.name === "ai-cortex");
		expect(self).toBeDefined();
		expect(self!.required).toBe(true);
	});

	it("marks missing optional repos as absent", () => {
		const repos = discoverRepos({
			extraRepoPaths: { "nonexistent-repo": "/tmp/no-such-repo-xyz" },
		});
		const missing = repos.find((r) => r.name === "nonexistent-repo");
		expect(missing).toBeUndefined(); // missing repos are filtered out
	});
});

describe("getSloForScenario", () => {
	it("returns SLO for known scenario and size", () => {
		const slo = getSloForScenario("index:cold", "small");
		expect(slo).toBe(300);
	});

	it("returns null for regression-only scenario", () => {
		const slo = getSloForScenario("rehydrate:stale", "small");
		expect(slo).toBeNull();
	});
});

describe("getConfig", () => {
	it("returns thresholds with defaults", () => {
		const config = getConfig();
		expect(config.thresholds.warnPct).toBe(10);
		expect(config.thresholds.failPct).toBe(20);
		expect(config.measurement.warmup).toBe(3);
		expect(config.measurement.runs).toBe(20);
	});

	it("returns reduced iterations in fast mode", () => {
		const config = getConfig({ fast: true });
		expect(config.measurement.warmup).toBe(1);
		expect(config.measurement.runs).toBe(3);
	});
});
