import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { synthesizeVerdict, THRESHOLDS } from "../../lib/stats/verdict.js";
import { THEME } from "../theme.js";

export type VerdictBandProps = {
	title: string;
	memoryUsedPct: number;
	recallToGetPct: number;
	suggestHitPct: number;
	errPct: number;
	totalSessions: number;
	totalCalls: number;
};

function dotChar(d: "green" | "yellow" | "muted"): string {
	return d === "green" ? "●" : d === "yellow" ? "◐" : "○";
}
function dotColor(d: "green" | "yellow" | "muted"): string {
	return d === "green" ? THEME.ok : d === "yellow" ? THEME.warn : THEME.muted;
}

function colorFor(value: number, good: number, ok: number): string {
	if (value >= good) return THEME.ok;
	if (value >= ok) return THEME.warn;
	return THEME.err;
}
function errColor(pct: number): string {
	return pct >= THRESHOLDS.errBad ? THEME.err : THEME.muted;
}

export function VerdictBand(p: VerdictBandProps): JSX.Element {
	const v = synthesizeVerdict({
		memoryUsedPct: p.memoryUsedPct,
		recallToGetPct: p.recallToGetPct,
		errPct: p.errPct,
		totalSessions: p.totalSessions,
		totalCalls: p.totalCalls,
	});
	return (
		<Box borderStyle="single" flexDirection="column" paddingX={1}>
			<Text bold>{p.title}</Text>
			<Text>
				<Text color={dotColor(v.dot)}>{dotChar(v.dot)}</Text> {v.text}
			</Text>
			<Text>
				<Text color={colorFor(p.memoryUsedPct, THRESHOLDS.memoryUsedGood, THRESHOLDS.memoryUsedOk)}>
					memory used {Math.round(p.memoryUsedPct)}%
				</Text>
				{"   ·   "}
				<Text color={colorFor(p.recallToGetPct, THRESHOLDS.recallToGetGood, THRESHOLDS.recallToGetOk)}>
					recall→get {Math.round(p.recallToGetPct)}%
				</Text>
				{"   ·   "}
				<Text color={colorFor(p.suggestHitPct, THRESHOLDS.suggestHitGood, THRESHOLDS.suggestHitOk)}>
					suggest hit {Math.round(p.suggestHitPct)}%
				</Text>
				{"   ·   "}
				<Text color={errColor(p.errPct)}>err {p.errPct.toFixed(1)}%</Text>
			</Text>
		</Box>
	);
}
