import { describe, it, expect } from "vitest";
import { produceCaptureCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

// Translated from the old positive-classifier contract: the extractor no
// longer types prompts as "decision"/"gotcha"/"how-to" and no longer scores
// confidence tiers. Every user turn that survives the structural gate becomes
// a single `type:"capture"` candidate; the agent judges durability later.

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [],
	filePaths: [],
	userPrompts: [],
	corrections: [],
	...overrides,
});

describe("produceCaptureCandidates — structural survivors are capture-typed", () => {
	it("emits one capture per structurally-clean turn (no decision typing)", () => {
		const out = produceCaptureCandidates(
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
		expect(out[0].type).toBe("capture");
		expect(out[0].typeFields).toBeUndefined();
	});

	it("emits a capture even with no acknowledgement snippet", () => {
		const out = produceCaptureCandidates(
			"s-3",
			ev({
				userPrompts: [
					{
						turn: 4,
						text: "always use POST for create endpoints, never GET",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("capture");
	});

	it("rejects structurally-noisy turns (vague ack / process control)", () => {
		const out = produceCaptureCandidates(
			"s-5",
			ev({
				userPrompts: [{ turn: 4, text: "ok" }],
			}),
		);
		expect(out).toEqual([]);
	});

	it("derives tags and scope files from the prompt and surrounding evidence", () => {
		const out = produceCaptureCandidates(
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
		const out = produceCaptureCandidates(
			"s-7",
			ev({
				userPrompts: [
					{ turn: 1, text: "actually, always prefer pino over winston" },
					{ turn: 2, text: "always use POST for create endpoints, never GET" },
				],
			}),
		);
		expect(out).toHaveLength(2);
		const correctionEntry = out.find((c: { title: string }) =>
			c.title.startsWith("actually,"),
		)!;
		const plainEntry = out.find((c: { title: string }) =>
			c.title.startsWith("always use POST"),
		)!;
		expect(correctionEntry.provenance[0].kind).toBe("user_correction");
		expect(plainEntry.provenance[0].kind).toBe("user_prompt");
	});
});
