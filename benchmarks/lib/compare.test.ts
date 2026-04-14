// benchmarks/lib/compare.test.ts
import { describe, it, expect } from "vitest";
import {
	checkRegression,
	checkSlo,
	loadBaselines,
	saveBaselines,
} from "./compare.js";
import type { ScenarioResult, SizeBucket } from "./types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("checkRegression", () => {
	it("returns pass when within threshold", () => {
		const status = checkRegression(100, 95, { warnPct: 10, failPct: 20 });
		expect(status).toEqual({ status: "pass", pct: 5.26 });
	});

	it("returns warn when between warn and fail threshold", () => {
		const status = checkRegression(100, 88, { warnPct: 10, failPct: 20 });
		expect(status).toEqual({ status: "warn", pct: 13.64 });
	});

	it("returns fail when exceeds fail threshold", () => {
		const status = checkRegression(100, 80, { warnPct: 10, failPct: 20 });
		expect(status).toEqual({ status: "fail", pct: 25 });
	});

	it("returns skip when baseline is null", () => {
		const status = checkRegression(100, null, { warnPct: 10, failPct: 20 });
		expect(status).toEqual({ status: "skip", pct: null });
	});
});

describe("checkSlo", () => {
	it("returns pass when under SLO", () => {
		expect(checkSlo(150, 200)).toBe(true);
	});

	it("returns fail when over SLO", () => {
		expect(checkSlo(250, 200)).toBe(false);
	});

	it("returns pass when SLO is null", () => {
		expect(checkSlo(250, null)).toBe(true);
	});
});

describe("loadBaselines / saveBaselines", () => {
	it("round-trips baseline data", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-compare-"));
		const filePath = path.join(tmpDir, "baselines.json");

		const data = {
			"ai-cortex": { "index:cold": 42, "rehydrate:warm": 3 },
		};

		saveBaselines(filePath, data);
		const loaded = loadBaselines(filePath);
		expect(loaded).toEqual(data);

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("returns empty object when file does not exist", () => {
		const loaded = loadBaselines("/tmp/nonexistent-baselines-xyz.json");
		expect(loaded).toEqual({});
	});
});
