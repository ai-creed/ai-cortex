import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { Aggregate, LatencyStats, ToolStat } from "../../lib/stats/query.js";
import { THEME } from "../theme.js";

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
				Latency (ms, p50/p95)
			</Text>
			{topTools.map((t) => {
				const l = latencyPerTool[t.tool] ?? { p50: 0, p95: 0, samples: 0 };
				return (
					<Text key={t.tool}>
						{t.tool.padEnd(22)} {String(l.p50).padStart(5)} / {String(l.p95).padStart(5)}
						{"  vol "}
						{String(t.n).padStart(5)}
						{t.errs > 0 ? (
							<Text color={THEME.err}>{`  err ${t.errs}`}</Text>
						) : (
							""
						)}
					</Text>
				);
			})}
			<Box marginTop={1}>
				<Text>
					Cache: fresh {aggregate.cache_status.fresh}  reindexed{" "}
					{aggregate.cache_status.reindexed}  stale {aggregate.cache_status.stale}
				</Text>
			</Box>
		</Box>
	);
}
