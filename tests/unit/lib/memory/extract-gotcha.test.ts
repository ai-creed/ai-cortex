import { describe, it, expect } from "vitest";
import { produceGotchaCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [], filePaths: [], userPrompts: [], corrections: [], ...overrides,
});

describe("produceGotchaCandidates", () => {
	it("emits a candidate when symptom + workaround signals are both present", () => {
		const out = produceGotchaCandidates("s-1", ev({
			corrections: [{
				turn: 6,
				text: "the build breaks on Linux because Parser isn't initialized",
				nextAssistantSnippet: "Fix: call Parser.init() once before parallel adapters instead of in each factory.",
			}],
			filePaths: [{ turn: 6, path: "src/adapters/python.ts" }],
		}));
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("gotcha");
		expect(out[0].confidence).toBeCloseTo(0.55, 2);
		expect(out[0].scopeFiles).toEqual(["src/adapters/python.ts"]);
		expect(out[0].typeFields).toEqual({ severity: "warning" });
	});

	it("emits at 0.45 when only the symptom is present", () => {
		const out = produceGotchaCandidates("s-2", ev({
			corrections: [{ turn: 1, text: "the test is flaky and hangs on CI" }],
		}));
		expect(out[0].confidence).toBeCloseTo(0.45, 2);
	});

	it("ignores corrections with neither symptom nor workaround signals", () => {
		const out = produceGotchaCandidates("s-3", ev({
			corrections: [{ turn: 1, text: "actually use a different name" }],
		}));
		expect(out).toEqual([]);
	});
});
