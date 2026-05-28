import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { THRESHOLDS } from "../../lib/stats/verdict.js";
import { THEME } from "../theme.js";

export type ActivityPanelProps = {
	total: number;
	p50: number;
	p95: number;
	errs: number;
};

export function ActivityPanel(p: ActivityPanelProps): JSX.Element {
	const errPct = p.total === 0 ? 0 : (p.errs / p.total) * 100;
	const errColor = errPct >= THRESHOLDS.errBad ? THEME.err : THEME.muted;
	return (
		<Box borderStyle="single" flexDirection="column" paddingX={1} width={36}>
			<Text bold color={THEME.accent}>Activity</Text>
			<Text>{p.total} calls</Text>
			<Text>p50 {p.p50}ms    p95 {p.p95}ms</Text>
			<Text color={errColor}>
				err {errPct.toFixed(1)}%   ({p.errs} of {p.total})
			</Text>
		</Box>
	);
}
