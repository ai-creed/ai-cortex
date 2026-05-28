import { describe, it, expect } from "vitest";
import {
	THRESHOLDS,
	THRESHOLD_TEXT,
	synthesizeVerdict,
	type VerdictInputs,
} from "../../../../src/lib/stats/verdict.js";

const baseGreen: VerdictInputs = {
	memoryUsedPct: 72,
	recallToGetPct: 72,
	errPct: 3.2,
	totalSessions: 11,
	totalCalls: 321,
};

describe("THRESHOLDS constants", () => {
	it("exposes numbers used by both synthesizer and overlay", () => {
		expect(THRESHOLDS.memoryUsedGood).toBe(50);
		expect(THRESHOLDS.memoryUsedOk).toBe(20);
		expect(THRESHOLDS.recallToGetGood).toBe(50);
		expect(THRESHOLDS.recallToGetOk).toBe(30);
		expect(THRESHOLDS.suggestHitGood).toBe(70);
		expect(THRESHOLDS.suggestHitOk).toBe(40);
		expect(THRESHOLDS.errBad).toBe(5);
		expect(THRESHOLDS.minSessions).toBe(5);
		expect(THRESHOLDS.minCalls).toBe(20);
	});

	it("exports threshold strings reused verbatim by the help overlay", () => {
		expect(THRESHOLD_TEXT.memoryUsed).toBe(">50% good · 20-50% ok · <20% not landing");
		expect(THRESHOLD_TEXT.recallToGet).toBe(">50% good · 30-50% ok · <30% recalls rarely landing");
		expect(THRESHOLD_TEXT.suggestHit).toBe(">70% good · 40-70% ok · <40% suggestions often empty");
		expect(THRESHOLD_TEXT.p50).toBe("p50: <100ms good · 100-300ms ok · >300ms slow");
		expect(THRESHOLD_TEXT.p95).toBe("p95: <500ms good · 500-1500ms ok · >1500ms slow");
		expect(THRESHOLD_TEXT.cacheMix).toBe(">70% fresh good · 40-70% fresh ok · <40% fresh = lots of reindexing");
	});
});

describe("synthesizeVerdict — low-sample floor", () => {
	it("returns muted when sessions < 5", () => {
		const v = synthesizeVerdict({ ...baseGreen, totalSessions: 4 });
		expect(v.dot).toBe("muted");
		expect(v.text).toBe("too little data yet to tell — keep using ai-cortex");
	});

	it("returns muted when calls < 20", () => {
		const v = synthesizeVerdict({ ...baseGreen, totalCalls: 19 });
		expect(v.dot).toBe("muted");
	});
});

describe("synthesizeVerdict — green path", () => {
	it("returns green when all three clauses pass", () => {
		const v = synthesizeVerdict(baseGreen);
		expect(v.dot).toBe("green");
		expect(v.text).toBe(
			"YES — saved memories get used in most sessions, recalls usually open, errors low",
		);
	});

	it("rejects green if memoryUsed exactly < 50", () => {
		const v = synthesizeVerdict({ ...baseGreen, memoryUsedPct: 49.9 });
		expect(v.dot).toBe("yellow");
	});

	it("rejects green if recall→get exactly < 30", () => {
		const v = synthesizeVerdict({ ...baseGreen, recallToGetPct: 29.9 });
		expect(v.dot).toBe("yellow");
	});

	it("rejects green if err% >= 5", () => {
		const v = synthesizeVerdict({ ...baseGreen, errPct: 5 });
		expect(v.dot).toBe("yellow");
	});
});

describe("synthesizeVerdict — mixed priority order", () => {
	it("priority 1: err% >= 5 names error rate even when other dims are fine", () => {
		const v = synthesizeVerdict({ ...baseGreen, errPct: 5.6 });
		expect(v.dot).toBe("yellow");
		expect(v.text).toBe("mixed — error rate is high");
	});

	it("priority 2: memoryUsed < 20 wins over recall failure", () => {
		const v = synthesizeVerdict({ ...baseGreen, memoryUsedPct: 10, recallToGetPct: 5 });
		expect(v.text).toBe("mixed — saved memories rarely get used");
	});

	it("priority 3: memoryUsed in [20,50)", () => {
		const v = synthesizeVerdict({ ...baseGreen, memoryUsedPct: 35 });
		expect(v.text).toBe("mixed — memories sometimes used but not consistently");
	});

	it("priority 4: recall→get < 30 (when memory clauses pass)", () => {
		const v = synthesizeVerdict({ ...baseGreen, recallToGetPct: 10 });
		expect(v.text).toBe("mixed — recalls rarely open a result");
	});
});
