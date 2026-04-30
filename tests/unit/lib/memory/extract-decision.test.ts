import { describe, it, expect } from "vitest";
import { produceDecisionCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [],
	filePaths: [],
	userPrompts: [],
	corrections: [],
	...overrides,
});

describe("produceDecisionCandidates", () => {
	it("emits a candidate for an imperative correction", () => {
		const out = produceDecisionCandidates(
			"s-1",
			ev({
				corrections: [
					{ turn: 4, text: "you must always use POST for create endpoints" },
				],
				filePaths: [{ turn: 5, path: "src/api/create.ts" }],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("decision");
		expect(out[0].confidence).toBeCloseTo(0.45, 2);
		expect(out[0].scopeFiles).toEqual(["src/api/create.ts"]);
		expect(out[0].provenance[0].sessionId).toBe("s-1");
	});

	it("bumps confidence to 0.55 when an acknowledgment cue is in nextAssistantSnippet", () => {
		const out = produceDecisionCandidates(
			"s-2",
			ev({
				corrections: [
					{
						turn: 4,
						text: "always prefer composition over inheritance",
						nextAssistantSnippet:
							"Got it — I'll use composition going forward.",
					},
				],
			}),
		);
		expect(out[0].confidence).toBeCloseTo(0.55, 2);
	});

	it("ignores corrections without imperative cues", () => {
		const out = produceDecisionCandidates(
			"s-3",
			ev({
				corrections: [{ turn: 4, text: "wait, hold on a sec" }],
			}),
		);
		expect(out).toEqual([]);
	});

	it("derives tags from the correction body", () => {
		const out = produceDecisionCandidates(
			"s-4",
			ev({
				corrections: [
					{
						turn: 1,
						text: "always validate webhook signatures before processing",
					},
				],
			}),
		);
		expect(out[0].tags).toEqual(
			expect.arrayContaining(["webhook", "signatures"]),
		);
	});
});
