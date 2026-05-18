import { describe, it, expect } from "vitest";
import { structuralReject } from "../../../../src/lib/memory/gate.js";
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
