import { describe, it, expect } from "vitest";
import { signalScore } from "../../../../src/lib/memory/gate.js";

describe("signalScore", () => {
	it("0 for a bare statement", () => {
		expect(signalScore("we changed the button color")).toBe(0);
	});
	it("+1 standing-directive lexeme", () => {
		expect(signalScore("always run tests before commit")).toBeGreaterThanOrEqual(
			1,
		);
	});
	it("+1 rationale connective (implicit forms count)", () => {
		expect(
			signalScore("make it agnostic, it is too specific to claude"),
		).toBeGreaterThanOrEqual(1);
	});
	it("+1 durable-correction shape", () => {
		expect(
			signalScore("Don't put call-graph in the prompt; grep is more efficient"),
		).toBeGreaterThanOrEqual(1);
	});
	it("deterministic and capped at 3", () => {
		const s =
			"always prefer X; do it because it is too specific; don't ever commit secrets";
		expect(signalScore(s)).toBe(signalScore(s));
		expect(signalScore(s)).toBeLessThanOrEqual(3);
	});
});
