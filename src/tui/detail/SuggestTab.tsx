import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { Aggregate } from "../../lib/stats/query.js";

export function SuggestTab({ aggregate }: { aggregate: Aggregate }): JSX.Element {
	const t = aggregate.cache_status.fresh + aggregate.cache_status.reindexed + aggregate.cache_status.stale;
	if (t === 0) return <Text>No suggest data yet.</Text>;
	const pct = (n: number) => `${Math.round((n / t) * 100)}%`;
	return (
		<Box flexDirection="column">
			<Text bold>Cache mix (suggest_files)</Text>
			<Text>fresh {pct(aggregate.cache_status.fresh)}</Text>
			<Text>reindexed {pct(aggregate.cache_status.reindexed)}</Text>
			<Text>stale {pct(aggregate.cache_status.stale)}</Text>
			<Box marginTop={1}>
				<Text dimColor>
					File paths intentionally omitted (privacy). See design doc §Suggest tab.
				</Text>
			</Box>
		</Box>
	);
}
