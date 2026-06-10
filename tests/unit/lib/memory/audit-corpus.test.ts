// tests/unit/lib/memory/audit-corpus.test.ts
import { describe, it, expect } from "vitest";
import {
	structuralReject,
	captureTier,
} from "../../../../src/lib/memory/gate.js";
import {
	AUDIT_KEEPERS,
	AUDIT_NOISE,
} from "../../../fixtures/memory-capture-corpus.js";

describe("2026-06-08 audit corpus (spec: zero keeper loss, ≥80% noise suppressed)", () => {
	it("has the expected labeled population", () => {
		expect(AUDIT_KEEPERS.length).toBe(11);
		expect(AUDIT_NOISE.length).toBe(128);
	});

	it("gate-rejects zero keepers", () => {
		for (const k of AUDIT_KEEPERS) {
			expect(
				structuralReject(k),
				`keeper wrongly gate-rejected: ${k.slice(0, 60)}`,
			).toBeNull();
		}
	});

	it("tiers zero keepers as low", () => {
		for (const k of AUDIT_KEEPERS) {
			expect(
				captureTier(k),
				`keeper wrongly low-tier: ${k.slice(0, 60)}`,
			).toBe("high");
		}
	});

	it("suppresses ≥80% of noise (gate-rejected OR low-tier)", () => {
		const suppressed = AUDIT_NOISE.filter(
			(n) => structuralReject(n.body) !== null || captureTier(n.body) === "low",
		).length;
		const ratio = suppressed / AUDIT_NOISE.length;
		expect(
			ratio,
			`only ${suppressed}/${AUDIT_NOISE.length} suppressed`,
		).toBeGreaterThanOrEqual(0.8);
	});
});
