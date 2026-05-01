import { describe, it, expect } from "vitest";
import { produceGotchaCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [],
	filePaths: [],
	userPrompts: [],
	corrections: [],
	...overrides,
});

describe("produceGotchaCandidates — confidence tiers", () => {
	it("0.55: correction prefix + symptom + workaround", () => {
		const out = produceGotchaCandidates(
			"s-1",
			ev({
				userPrompts: [
					{
						turn: 6,
						text: "actually, the build breaks on Linux because Parser isn't initialized",
						nextAssistantSnippet:
							"Fix: call Parser.init() once before parallel adapters instead of in each factory.",
					},
				],
				filePaths: [{ turn: 6, path: "src/adapters/python.ts" }],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("gotcha");
		expect(out[0].confidence).toBeCloseTo(0.55, 2);
		expect(out[0].scopeFiles).toEqual(["src/adapters/python.ts"]);
		expect(out[0].typeFields).toEqual({ severity: "warning" });
	});

	it("0.45: symptom + workaround, no correction prefix", () => {
		const out = produceGotchaCandidates(
			"s-2",
			ev({
				userPrompts: [
					{
						turn: 6,
						text: "the build breaks on Linux because Parser isn't initialized",
						nextAssistantSnippet:
							"Fix: call Parser.init() once before parallel adapters.",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.45, 2);
	});

	it("0.45: symptom + correction prefix, no workaround", () => {
		const out = produceGotchaCandidates(
			"s-3",
			ev({
				userPrompts: [
					{ turn: 1, text: "actually the test is flaky and hangs on CI" },
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.45, 2);
	});

	it("0.35: bare symptom, no boost", () => {
		const out = produceGotchaCandidates(
			"s-4",
			ev({
				userPrompts: [{ turn: 1, text: "the test is flaky and hangs on CI" }],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.35, 2);
	});

	it("ignores prompts without symptom cues", () => {
		const out = produceGotchaCandidates(
			"s-5",
			ev({
				userPrompts: [{ turn: 1, text: "actually use a different name" }],
			}),
		);
		expect(out).toEqual([]);
	});
});
