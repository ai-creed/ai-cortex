// tests/unit/lib/memory/noise-taxonomy.test.ts
import { describe, it, expect } from "vitest";
import { isNoiseTaxonomyReason } from "../../../../src/lib/memory/noise-taxonomy.js";

describe("isNoiseTaxonomyReason", () => {
	it.each([
		"one-off-ux-feedback",
		"specific-bug-report-no-durable-rule",
		"transient session chatter",
		"noise: screenshot path",
		"bulk-triage-2026-07-intake-filter-match",
		"aging: low-signal capture untouched >14d",
		"intake: zero-signal capture",
	])("noise: %s", (reason) => {
		expect(isNoiseTaxonomyReason(reason)).toBe(true);
	});

	it.each([
		"superseded by mem-2026-06-01-newer-rule",
		"consolidated into the release runbook card",
		"stale after v0.12 architecture change",
		null,
		undefined,
		"",
	])("NOT noise: %s", (reason) => {
		expect(isNoiseTaxonomyReason(reason as string | null | undefined)).toBe(false);
	});
});
