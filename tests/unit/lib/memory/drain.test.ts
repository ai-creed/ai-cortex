// P2 backlog drain: the one-time bulk-triage decision function. Scores the
// ROUTED PROMPT (routedPromptFromBody), never the composed body — body-layer
// scoring is the echo-inflation defect the replay gate pins (see
// replay-gate.test.ts). Keeper bodies from the harvest corpus are exempt from
// auto-action no matter how they score: the drain must not be able to destroy
// a known gem, mirroring the gate's zero-gem-loss rule.
import { describe, it, expect } from "vitest";
import { captureTier } from "../../../../src/lib/memory/gate.js";
import { decideDrain, DRAIN_REASON } from "../../../../src/lib/memory/drain.js";
import { HARVEST_KEEPERS } from "../../../fixtures/memory-capture-corpus.js";

const ZERO_SIGNAL_PROMPT = "took a quick look at the dashboard earlier today";
const HIGH_SIGNAL_ECHO =
	"_Acknowledged:_ Always route zero-signal captures to trash because the backlog diverges otherwise.";

const candidateCapture = (body: string) => ({
	status: "candidate",
	type: "capture",
	body,
});

describe("decideDrain", () => {
	it("only acts on candidate captures", () => {
		expect(
			decideDrain({ status: "active", type: "capture", body: "x" }, new Set()),
		).toEqual({ action: "keep", why: "not-candidate-capture" });
		expect(
			decideDrain(
				{ status: "candidate", type: "decision", body: "x" },
				new Set(),
			),
		).toEqual({ action: "keep", why: "not-candidate-capture" });
	});

	it("trashes a structurally-rejected candidate capture with the rule name", () => {
		const decision = decideDrain(
			candidateCapture("[Request interrupted by user] and then some context"),
			new Set(),
		);
		expect(decision).toEqual({ action: "trash", rule: "interrupt-marker" });
	});

	it("trashes an unrejected zero-signal candidate capture as low-tier", () => {
		expect(decideDrain(candidateCapture(ZERO_SIGNAL_PROMPT), new Set())).toEqual(
			{ action: "trash", rule: "low-tier" },
		);
	});

	it("scores the routed prompt, not the echo-inflated composed body", () => {
		const composed = `${ZERO_SIGNAL_PROMPT}\n\n${HIGH_SIGNAL_ECHO}`;
		// Differential precondition: the composed body scores high, so a
		// body-layer drain would keep it. The prompt layer must trash it.
		expect(captureTier(composed)).toBe("high");
		expect(decideDrain(candidateCapture(composed), new Set())).toEqual({
			action: "trash",
			rule: "low-tier",
		});
	});

	it("keeps a high-signal candidate capture for the human pass", () => {
		expect(
			decideDrain(candidateCapture(HARVEST_KEEPERS[0]), new Set()),
		).toEqual({ action: "keep", why: "high-tier" });
	});

	it("exempts keeper bodies before any scoring, even zero-signal ones", () => {
		const keepers = new Set([
			HARVEST_KEEPERS[0].trim(),
			ZERO_SIGNAL_PROMPT.trim(),
		]);
		expect(
			decideDrain(candidateCapture(HARVEST_KEEPERS[0]), keepers),
		).toEqual({ action: "keep", why: "keeper-exempt" });
		// A keeper that would otherwise be trashed as low-tier stays.
		expect(decideDrain(candidateCapture(ZERO_SIGNAL_PROMPT), keepers)).toEqual({
			action: "keep",
			why: "keeper-exempt",
		});
	});

	it("uses the plan's auditable bulk-triage reason", () => {
		expect(DRAIN_REASON).toBe("bulk-triage-2026-07-intake-filter-match");
	});
});
