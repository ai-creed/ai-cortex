import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { Aggregate, LatencyStats, ToolStat } from "../../lib/stats/query.js";
import { THEME } from "../theme.js";

const W_TOOL = 22;
const W_P50 = 6;
const W_P95 = 7;
const W_CALLS = 8;
const W_ERR = 6;

export function ToolsTab({
	aggregate,
	latencyPerTool,
	topTools,
}: {
	aggregate: Aggregate;
	latencyPerTool: Record<string, LatencyStats>;
	topTools: ToolStat[];
}): JSX.Element {
	if (topTools.length === 0) return <Text>No tool data yet.</Text>;

	return (
		<Box flexDirection="column">
			<Text bold color={THEME.accent}>
				Tools — latency &amp; volume
			</Text>

			<Text bold color={THEME.accent}>
				{"TOOL".padEnd(W_TOOL)}
				{"p50".padStart(W_P50)}
				{"p95".padStart(W_P95)}
				{"CALLS".padStart(W_CALLS)}
				{"ERR".padStart(W_ERR)}
			</Text>

			{topTools.map((t) => {
				const l = latencyPerTool[t.tool] ?? { p50: 0, p95: 0, samples: 0 };
				return (
					<Text key={t.tool}>
						{t.tool.slice(0, W_TOOL - 1).padEnd(W_TOOL)}
						{String(l.p50).padStart(W_P50)}
						{String(l.p95).padStart(W_P95)}
						{String(t.n).padStart(W_CALLS)}
						<Text color={t.errs > 0 ? THEME.err : THEME.muted}>
							{String(t.errs).padStart(W_ERR)}
						</Text>
					</Text>
				);
			})}

			<Box marginTop={1}>
				<Text>
					Cache results{"   "}
					<Text color={THEME.ok}>fresh {aggregate.cache_status.fresh}</Text>
					{"   "}reindexed {aggregate.cache_status.reindexed}
					{"   "}
					<Text color={THEME.warn}>stale {aggregate.cache_status.stale}</Text>
				</Text>
			</Box>

			<Box flexDirection="column" marginTop={1}>
				<Text color={THEME.muted}>
					p50/p95 median &amp; 95th-pct latency, ms (live calls only —
				</Text>
				<Text color={THEME.muted}>
					{"        "}backfilled history has no timing, shows 0)
				</Text>
				<Text color={THEME.muted}>
					CALLS{"   "}invocations in the selected window
				</Text>
				<Text color={THEME.muted}>
					ERR{"     "}failed invocations · Cache = suggest_files outcomes
				</Text>
			</Box>
		</Box>
	);
}
