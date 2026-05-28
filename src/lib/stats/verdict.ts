// src/lib/stats/verdict.ts
//
// Single source of truth for verdict synthesis, the threshold strings that
// appear verbatim in the help overlay, and the cutoffs used to color the
// Effectiveness / Activity panels.

export const THRESHOLDS = {
	memoryUsedGood: 50,
	memoryUsedOk: 20,
	recallToGetGood: 50,
	recallToGetOk: 30,
	suggestHitGood: 70,
	suggestHitOk: 40,
	errBad: 5,
	minSessions: 5,
	minCalls: 20,
} as const;

export const THRESHOLD_TEXT = {
	memoryUsed: ">50% good · 20-50% ok · <20% not landing",
	recallToGet: ">50% good · 30-50% ok · <30% recalls rarely landing",
	suggestHit: ">70% good · 40-70% ok · <40% suggestions often empty",
	p50: "p50: <100ms good · 100-300ms ok · >300ms slow",
	p95: "p95: <500ms good · 500-1500ms ok · >1500ms slow",
	cacheMix: ">70% fresh good · 40-70% fresh ok · <40% fresh = lots of reindexing",
} as const;

export type VerdictDot = "green" | "yellow" | "muted";

export type Verdict = {
	dot: VerdictDot;
	text: string;
};

export type VerdictInputs = {
	memoryUsedPct: number;
	recallToGetPct: number;
	errPct: number;
	totalSessions: number;
	totalCalls: number;
};

const GREEN_TEXT =
	"YES — saved memories get used in most sessions, recalls usually open, errors low";
const MUTED_TEXT = "too little data yet to tell — keep using ai-cortex";

export function synthesizeVerdict(i: VerdictInputs): Verdict {
	if (i.totalSessions < THRESHOLDS.minSessions || i.totalCalls < THRESHOLDS.minCalls) {
		return { dot: "muted", text: MUTED_TEXT };
	}
	const green =
		i.memoryUsedPct >= THRESHOLDS.memoryUsedGood &&
		i.recallToGetPct >= THRESHOLDS.recallToGetOk &&
		i.errPct < THRESHOLDS.errBad;
	if (green) return { dot: "green", text: GREEN_TEXT };

	// Mixed-verdict naming: first failing dimension in priority order.
	if (i.errPct >= THRESHOLDS.errBad) {
		return { dot: "yellow", text: "mixed — error rate is high" };
	}
	if (i.memoryUsedPct < THRESHOLDS.memoryUsedOk) {
		return { dot: "yellow", text: "mixed — saved memories rarely get used" };
	}
	if (i.memoryUsedPct < THRESHOLDS.memoryUsedGood) {
		return {
			dot: "yellow",
			text: "mixed — memories sometimes used but not consistently",
		};
	}
	return { dot: "yellow", text: "mixed — recalls rarely open a result" };
}
