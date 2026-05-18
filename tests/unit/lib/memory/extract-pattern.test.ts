import { describe, it, expect } from "vitest";
import * as extract from "../../../../src/lib/memory/extract.js";
import { produceCaptureCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

// Translated from the old cross-session pattern-classifier contract. The
// structural-gate rewrite removed `producePatternCandidates` entirely: the
// extractor no longer aggregates co-occurring file sets across sessions into a
// `type:"pattern"` memory. Coverage is translated to the surviving behaviour —
// the single capture producer is per-turn and never aggregates across
// sessions.

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [],
	filePaths: [],
	userPrompts: [],
	corrections: [],
	...overrides,
});

describe("pattern producer removal", () => {
	it("producePatternCandidates is no longer exported", () => {
		expect(
			(extract as Record<string, unknown>).producePatternCandidates,
		).toBeUndefined();
	});

	it("capture producer is per-turn and does not aggregate cross-session co-occurrence", () => {
		const files = [
			{ turn: 1, path: "src/cache-store.ts" },
			{ turn: 1, path: "src/lib/memory/store.ts" },
		];
		const out = produceCaptureCandidates(
			"s-a",
			ev({
				userPrompts: [
					{
						turn: 1,
						text: "always add an atomic write helper for the cache layer files",
					},
				],
				filePaths: files,
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("capture");
		expect(out[0].type).not.toBe("pattern");
		expect(out[0].scopeFiles).toEqual(
			expect.arrayContaining([
				"src/cache-store.ts",
				"src/lib/memory/store.ts",
			]),
		);
	});
});
