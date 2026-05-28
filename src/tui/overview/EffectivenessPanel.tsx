import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { THRESHOLDS } from "../../lib/stats/verdict.js";
import { THEME } from "../theme.js";

export type EffectivenessPanelProps = {
	memoryUsedPct: number;
	recallToGetPct: number;
	suggestHitPct: number;
};

function colorFor(value: number, good: number, ok: number): string {
	if (value >= good) return THEME.ok;
	if (value >= ok) return THEME.warn;
	return THEME.err;
}

export function EffectivenessPanel(p: EffectivenessPanelProps): JSX.Element {
	const rows: Array<[string, number, number, number]> = [
		["memory used", p.memoryUsedPct, THRESHOLDS.memoryUsedGood, THRESHOLDS.memoryUsedOk],
		["recall→get", p.recallToGetPct, THRESHOLDS.recallToGetGood, THRESHOLDS.recallToGetOk],
		["suggest hit", p.suggestHitPct, THRESHOLDS.suggestHitGood, THRESHOLDS.suggestHitOk],
	];
	return (
		<Box borderStyle="single" flexDirection="column" paddingX={1} width={32}>
			<Text bold color={THEME.accent}>Effectiveness</Text>
			{rows.map(([label, v, good, ok]) => (
				<Text key={label}>
					{label.padEnd(14)}{" "}
					<Text color={colorFor(v, good, ok)}>{`${Math.round(v)}%`.padStart(5)}</Text>
				</Text>
			))}
		</Box>
	);
}
