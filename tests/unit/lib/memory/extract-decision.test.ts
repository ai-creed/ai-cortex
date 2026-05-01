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

describe("produceDecisionCandidates — confidence tiers", () => {
	it("0.55: correction prefix + imperative + assistant ACK", () => {
		const out = produceDecisionCandidates(
			"s-1",
			ev({
				userPrompts: [
					{
						turn: 4,
						text: "actually, always prefer composition over inheritance",
						nextAssistantSnippet:
							"Got it — I'll use composition going forward.",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.55, 2);
	});

	it("0.45: imperative + ACK, no correction prefix", () => {
		const out = produceDecisionCandidates(
			"s-2",
			ev({
				userPrompts: [
					{
						turn: 4,
						text: "always use POST for create endpoints",
						nextAssistantSnippet: "Understood — POST it is.",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.45, 2);
	});

	it("0.45: imperative + correction prefix, no ACK", () => {
		const out = produceDecisionCandidates(
			"s-3",
			ev({
				userPrompts: [
					{
						turn: 4,
						text: "actually, always use POST for create endpoints",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.45, 2);
	});

	it("0.35: bare imperative, no ACK, no correction prefix", () => {
		const out = produceDecisionCandidates(
			"s-4",
			ev({
				userPrompts: [
					{
						turn: 4,
						text: "always use POST for create endpoints",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].confidence).toBeCloseTo(0.35, 2);
	});

	it("ignores prompts without imperative cues", () => {
		const out = produceDecisionCandidates(
			"s-5",
			ev({
				userPrompts: [{ turn: 4, text: "wait, hold on a sec" }],
			}),
		);
		expect(out).toEqual([]);
	});

	it("derives tags and scope files from the prompt and surrounding evidence", () => {
		const out = produceDecisionCandidates(
			"s-6",
			ev({
				userPrompts: [
					{
						turn: 5,
						text: "always validate webhook signatures before processing",
					},
				],
				filePaths: [{ turn: 5, path: "src/api/create.ts" }],
			}),
		);
		expect(out[0].tags).toEqual(
			expect.arrayContaining(["webhook", "signatures"]),
		);
		expect(out[0].scopeFiles).toEqual(["src/api/create.ts"]);
	});

	it("provenance kind reflects whether the prompt was a correction", () => {
		const out = produceDecisionCandidates(
			"s-7",
			ev({
				userPrompts: [
					{ turn: 1, text: "actually, always prefer pino over winston" },
					{ turn: 2, text: "always use POST for create endpoints" },
				],
			}),
		);
		expect(out).toHaveLength(2);
		const correctionEntry = out.find((c) =>
			c.title.startsWith("actually,"),
		)!;
		const plainEntry = out.find((c) => c.title.startsWith("always use POST"))!;
		expect(correctionEntry.provenance[0].kind).toBe("user_correction");
		expect(plainEntry.provenance[0].kind).toBe("user_prompt");
	});
});
