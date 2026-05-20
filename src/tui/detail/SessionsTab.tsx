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
			<Text dimColor>
				{" "} ↳ sessions where get_memory or record_memory ran
			</Text>
			<Text>recall→get {pct(summary.recallToGetPct)}</Text>
			<Text dimColor>
				{" "} ↳ recall sessions that then did get_memory (the cardinal pattern)
			</Text>
			<Text>surface→get {pct(summary.surfaceToGetPct)}</Text>
			<Text dimColor>
				{" "} ↳ surfacings followed by a later get_memory same session
			</Text>
			<Text>extract→cleanup {pct(summary.extractCleanupPct)}</Text>
			<Text dimColor>
				{" "} ↳ Σ cleanup ÷ Σ extracted candidates (window-level)
			</Text>
			<Text dimColor>
				unattributed {(summary.unattributedShare * 100).toFixed(0)}% of events
				{"  "}↳ lower = numbers more reliable
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
			<Box marginTop={1}>
				<Text dimColor>
					combined-read patterns + calibration debt: docs/shared/adoption-metrics.md
				</Text>
			</Box>
		</Box>
	);
}
