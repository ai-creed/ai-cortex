// tests/unit/lib/memory/replay-gate.test.ts
// Spec §5: THE release gate. No waiver mechanism exists — a failing keeper is
// fixed by tuning signalScore markers, never by relabeling or excluding.
//
// The gate models the ROUTED PROMPT, exactly as extraction does. Intake routing
// decides on captureTier(u.text) — the raw user prompt — but the stored capture
// body is the composed prompt + "\n\n_Acknowledged:_ <echo>". Scoring the body
// would let the assistant echo inflate a prompt's signal and pass gems that the
// real routing layer would trash. Every hard-gate evaluation therefore recovers
// the routed prompt via routedPromptFromBody(body) before scoring.
import { describe, it, expect } from "vitest";
import {
	structuralReject,
	captureTier,
} from "../../../../src/lib/memory/gate.js";
import { routedPromptFromBody } from "../../../../src/lib/memory/extract.js";
import {
	AUDIT_KEEPERS,
	AUDIT_NOISE,
	ROLEPLAY_NOISE,
	HARVEST_KEEPERS,
	HARVEST_NOISE,
	HARVEST_COVERAGE,
} from "../../../fixtures/memory-capture-corpus.js";

// Suppression models the routed prompt layer — score the recovered prompt, not
// the acknowledgement-inflated body.
const wouldSuppress = (b: string): boolean => {
	const prompt = routedPromptFromBody(b);
	return structuralReject(prompt) !== null || captureTier(prompt) === "low";
};

describe("replay gate: gem loss (hard, zero, per-case)", () => {
	// Full-fidelity keepers: every one must SURVIVE at the ROUTED PROMPT layer
	// (gate pass + high tier) — the same layer intake routing decides on.
	it.each(HARVEST_KEEPERS.map((b, i) => [i, b] as const))(
		"harvest keeper #%d survives intake",
		(_i, body) => {
			const prompt = routedPromptFromBody(body);
			expect(structuralReject(prompt)).toBeNull();
			expect(captureTier(prompt)).toBe("high");
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

// Acknowledgement-inflation regressions (finding 4): two harvest keepers score
// high ONLY because the stored body carries the assistant echo. At the routed
// prompt layer — the layer routing actually decides on — their prompts scored
// zero-signal (pure tier shortfall), so scoring the body would have passed a
// gem the real gate trashes. Located by a distinctive prompt substring, never
// by array index (index is brittle across corpus edits).
describe("replay gate: acknowledgement-inflated keepers (routed-layer regression)", () => {
	const cases: { label: string; needle: string }[] = [
		{ label: "dogfood duplex loop", needle: "I need both s1/s2 to dogfood" },
		{
			label: "samantha desktop reframe",
			needle: "Most UI redesign. Initially we designed",
		},
	];
	it.each(cases)("$label: routed prompt survives on its own signal", ({ needle }) => {
		const body = HARVEST_KEEPERS.find((b) => b.includes(needle));
		expect(body, `no harvest keeper contains "${needle}"`).toBeDefined();
		const prompt = routedPromptFromBody(body!);
		// The prompt genuinely differs from the body: the echo was stripped.
		expect(prompt.length).toBeLessThan(body!.length);
		// The regression exists because the BODY was high-tier via echo inflation…
		expect(captureTier(body!)).toBe("high");
		// …yet the ROUTED PROMPT must now survive on its own durable-rule signal.
		expect(structuralReject(prompt)).toBeNull();
		expect(captureTier(prompt)).toBe("high");
	});
});

describe("replay gate: junk suppression ≥ 80%", () => {
	it("labeled noise is suppressed at or above the spec threshold", () => {
		// Score the routed prompt for every noise body, the same layer routing
		// evaluates — labeled-noise suppression is measured where the decision is.
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
