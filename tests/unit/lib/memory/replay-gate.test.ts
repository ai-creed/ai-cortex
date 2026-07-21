// tests/unit/lib/memory/replay-gate.test.ts
// Spec §5: THE release gate. No waiver mechanism exists — a failing keeper is
// fixed by tuning signalScore markers, never by relabeling or excluding.
import { describe, it, expect } from "vitest";
import {
	structuralReject,
	captureTier,
} from "../../../../src/lib/memory/gate.js";
import {
	AUDIT_KEEPERS,
	AUDIT_NOISE,
	ROLEPLAY_NOISE,
	HARVEST_KEEPERS,
	HARVEST_NOISE,
	HARVEST_COVERAGE,
} from "../../../fixtures/memory-capture-corpus.js";

const wouldSuppress = (b: string): boolean =>
	structuralReject(b) !== null || captureTier(b) === "low";

describe("replay gate: gem loss (hard, zero, per-case)", () => {
	// Full-fidelity keepers: every one must SURVIVE (gate pass + high tier).
	it.each(HARVEST_KEEPERS.map((b, i) => [i, b] as const))(
		"harvest keeper #%d survives intake",
		(_i, body) => {
			expect(structuralReject(body)).toBeNull();
			expect(captureTier(body)).toBe("high");
		},
	);

	// 2026-06-08 keepers are excerpt-fidelity: advisory-only (spec §5). Report
	// without failing the gate — truncated excerpts are not intake bodies.
	it("excerpt-fidelity keepers: advisory survival report", () => {
		const lost = AUDIT_KEEPERS.filter((b) => wouldSuppress(b));
		console.info(
			`[replay-gate advisory] excerpt-fidelity keepers suppressed: ${lost.length}/${AUDIT_KEEPERS.length}`,
		);
		expect(AUDIT_KEEPERS.length).toBe(11);
	});
});

describe("replay gate: junk suppression ≥ 80%", () => {
	it("labeled noise is suppressed at or above the spec threshold", () => {
		const noise = [...AUDIT_NOISE.map((n) => n.body), ...HARVEST_NOISE, ...ROLEPLAY_NOISE];
		const suppressed = noise.filter(wouldSuppress).length;
		const rate = suppressed / noise.length;
		expect(rate).toBeGreaterThanOrEqual(0.8);
	});
});

describe("replay gate: harvest-coverage structural precondition", () => {
	it("the tier-blind pass covered both required populations (spec §5)", () => {
		expect(HARVEST_COVERAGE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// populations must be real (unfilled harvest = zero = hard fail)
		expect(HARVEST_COVERAGE.highTierPopulation).toBeGreaterThan(0);
		expect(HARVEST_COVERAGE.zeroSignalPopulation).toBeGreaterThan(0);
		// EVERY high-tier survivor was labeled
		expect(HARVEST_COVERAGE.highTierInspected).toBe(
			HARVEST_COVERAGE.highTierPopulation,
		);
		// zero-signal floor: min(100, population) — "all of them if fewer exist"
		const zeroFloor = Math.min(100, HARVEST_COVERAGE.zeroSignalPopulation);
		expect(HARVEST_COVERAGE.zeroSignalInspected).toBeGreaterThanOrEqual(
			zeroFloor,
		);
		// every zero-signal gem found MUST be present as a harvest keeper —
		// gems can only be "found" by being frozen into the gate population
		expect(HARVEST_KEEPERS.length).toBeGreaterThanOrEqual(
			HARVEST_COVERAGE.gemsFound,
		);
	});
});
