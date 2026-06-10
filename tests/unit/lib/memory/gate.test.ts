import { describe, it, expect } from "vitest";
import {
	structuralReject,
	captureTier,
	signalScore,
} from "../../../../src/lib/memory/gate.js";
import { NOISE, KEEPERS } from "../../../fixtures/memory-capture-corpus.js";

describe("structuralReject", () => {
	it("rejects every noise sample (returns a non-null reason)", () => {
		for (const n of NOISE) {
			const r = structuralReject(n.body);
			expect(
				r,
				`expected reject for [${n.bucket}] ${n.body.slice(0, 40)}`,
			).not.toBeNull();
		}
	});
	it("keeps every genuine keeper (returns null)", () => {
		for (const k of KEEPERS) {
			expect(
				structuralReject(k),
				`wrongly rejected: ${k.slice(0, 50)}`,
			).toBeNull();
		}
	});
});

describe("captureTier", () => {
	it("is high iff signalScore >= 1", () => {
		expect(captureTier("push it, and we can prepare a new patch release")).toBe("low");
		expect(captureTier("always run pnpm build before tagging")).toBe("high"); // standing directive
		expect(captureTier("use sqlite here because the index must be rebuildable")).toBe("high"); // rationale
		expect(captureTier("no, don't write into the target repo")).toBe("high"); // correction shape
		expect(captureTier("")).toBe("low"); // total on empty input
	});
	it("agrees with signalScore on the existing corpus", () => {
		for (const k of KEEPERS) {
			expect(captureTier(k)).toBe(signalScore(k) >= 1 ? "high" : "low");
		}
	});
});
