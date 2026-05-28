import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { THRESHOLD_TEXT } from "../../lib/stats/verdict.js";
import { THEME } from "../theme.js";

const ROWS: Array<{ label: string; desc: string; threshold: string }> = [
	{
		label: "memory used %",
		desc: "sessions where a saved memory was actually opened/used.",
		threshold: `THE adoption signal.  ${THRESHOLD_TEXT.memoryUsed}`,
	},
	{
		label: "recall→get %",
		desc: "of sessions that searched memory, how many then opened a result.",
		threshold: THRESHOLD_TEXT.recallToGet,
	},
	{
		label: "suggest hit %",
		desc: "suggest_files calls that returned at least one file.",
		threshold: THRESHOLD_TEXT.suggestHit,
	},
	{
		label: "p50 / p95",
		desc: "median & 95th-pct latency, ms (live calls only; backfill shows 0).",
		threshold: `${THRESHOLD_TEXT.p50}\n                 ${THRESHOLD_TEXT.p95}`,
	},
	{
		label: "cache mix",
		desc: "index reads served fresh / reindexed / stale.",
		threshold: THRESHOLD_TEXT.cacheMix,
	},
];

export function HelpOverlay(): JSX.Element {
	return (
		<Box borderStyle="single" flexDirection="column" paddingX={1}>
			<Text bold>What these numbers mean</Text>
			<Text> </Text>
			{ROWS.map((r) => (
				<Box key={r.label} flexDirection="column">
					<Text>
						<Text color={THEME.accent} bold>
							{r.label.padEnd(15)}
						</Text>
						{" "}
						{r.desc}
					</Text>
					<Text>                 {r.threshold}</Text>
				</Box>
			))}
			<Text> </Text>
			<Text>
				<Text bold>Verdict</Text>{"   "}
				<Text color={THEME.ok}>● helping</Text>{"   "}
				<Text color={THEME.warn}>◐ mixed</Text>{"   "}
				<Text color={THEME.muted}>○ too little data yet</Text>
			</Text>
			<Text> </Text>
			<Text dimColor>press ? or Esc to close</Text>
		</Box>
	);
}
