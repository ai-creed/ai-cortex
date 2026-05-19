import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { AdoptionSummary, SessionRow } from "../../lib/stats/sessions.js";
import type { StatsWindow } from "../../lib/stats/types.js";
import { THEME } from "../theme.js";

export function SessionsTab({
	adoption,
	window: windowProp,
}: {
	adoption: { sessions: SessionRow[]; summary: AdoptionSummary };
	window: StatsWindow;
}): JSX.Element {
	const { sessions, summary } = adoption;
	const pct = (n: number) => `${n.toFixed(0)}%`;
	return (
		<Box flexDirection="column">
			<Text bold color={THEME.accent}>
				Memory used: {pct(summary.memoryUsedPct)} ({summary.histogram.used}/
				{summary.sessionCount} sessions, {windowProp})
			</Text>
			<Text>
				recall→get {pct(summary.recallToGetPct)} · surface→get{" "}
				{pct(summary.surfaceToGetPct)} · extract→cleanup{" "}
				{pct(summary.extractCleanupPct)}
			</Text>
			<Text dimColor>
				unattributed {(summary.unattributedShare * 100).toFixed(0)}% of events
				(lower = more reliable)
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{sessions.slice(0, 15).map((s) => (
					<Text key={s.sessionId}>
						{s.sessionId.slice(0, 18).padEnd(18)} calls={s.totalCalls} r=
						{s.recall} g={s.get} surf={s.surfacings}{" "}
						{s.memoryUsed ? (
							<Text color={THEME.ok}>USED</Text>
						) : (
							<Text color={THEME.muted}>—</Text>
						)}
					</Text>
				))}
			</Box>
		</Box>
	);
}
