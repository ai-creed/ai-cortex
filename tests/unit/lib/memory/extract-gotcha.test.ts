import { describe, it, expect } from "vitest";
import { produceCaptureCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

// Translated from the old gotcha-classifier contract: symptom/workaround
// prompts are no longer typed "gotcha" and no longer carry a
// `severity: "warning"` typeField. Structurally-clean turns become plain
// `type:"capture"` candidates regardless of their semantic flavour.

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [],
	filePaths: [],
	userPrompts: [],
	corrections: [],
	...overrides,
});

describe("produceCaptureCandidates — symptom prompts are capture-typed", () => {
	it("emits a capture for a symptom+workaround turn (no gotcha typing/typeFields)", () => {
		const out = produceCaptureCandidates(
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
		expect(out[0].type).toBe("capture");
		expect(out[0].typeFields).toBeUndefined();
		expect(out[0].scopeFiles).toEqual(["src/adapters/python.ts"]);
	});

	it("emits a capture for a bare symptom turn", () => {
		const out = produceCaptureCandidates(
			"s-4",
			ev({
				userPrompts: [
					{
						turn: 1,
						text: "the integration test is flaky and hangs on CI runners",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("capture");
	});

	it("rejects structurally-noisy turns even if they read like a symptom", () => {
		const out = produceCaptureCandidates(
			"s-5",
			ev({
				userPrompts: [
					{
						turn: 1,
						text: "still the same. Uncaught TypeError: x is not a function at y",
					},
				],
			}),
		);
		expect(out).toEqual([]);
	});
});
