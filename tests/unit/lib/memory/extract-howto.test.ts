import { describe, it, expect } from "vitest";
import { produceCaptureCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

// Translated from the old how-to-classifier contract: "how do I…" prompts are
// no longer typed "how-to" and no longer require ≥3 sequential tool calls. A
// structurally-clean turn becomes a single `type:"capture"` candidate; a
// structurally-noisy question is rejected by the gate.

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [],
	filePaths: [],
	userPrompts: [],
	corrections: [],
	...overrides,
});

describe("produceCaptureCandidates — directive turns are capture-typed", () => {
	it("emits a capture for a structurally-clean standing directive", () => {
		const out = produceCaptureCandidates(
			"s-1",
			ev({
				userPrompts: [
					{
						turn: 1,
						text: "always deploy by building the docker image then pushing to the registry",
					},
				],
				filePaths: [{ turn: 1, path: "Dockerfile" }],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("capture");
		expect(out[0].scopeFiles).toEqual(["Dockerfile"]);
	});

	it("rejects a bare question turn (structural gate: question)", () => {
		const out = produceCaptureCandidates(
			"s-3",
			ev({
				userPrompts: [{ turn: 1, text: "how do I deploy this service?" }],
				toolCalls: [
					{ turn: 2, name: "Bash", args: "x" },
					{ turn: 3, name: "Bash", args: "y" },
					{ turn: 4, name: "Bash", args: "z" },
				],
			}),
		);
		expect(out).toEqual([]);
	});

	it("does not require tool calls to emit a capture", () => {
		const out = produceCaptureCandidates(
			"s-4",
			ev({
				userPrompts: [
					{
						turn: 1,
						text: "never disable git hooks during a commit, even with --no-verify",
					},
				],
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("capture");
	});
});
