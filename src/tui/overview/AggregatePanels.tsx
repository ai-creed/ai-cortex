import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { Aggregate, MemoryHealth } from "../../lib/stats/query.js";

function mb(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function storageLabel(
	repoKey: string,
	projectNames: Record<string, string | null>,
): string {
	const raw = projectNames[repoKey] ?? repoKey.slice(0, 14);
	return raw.length > 14 ? raw.slice(0, 13) + "…" : raw.padEnd(14);
}

export function AggregatePanels({
	aggregate,
	memory,
	storage,
	recallGetRatio,
	projectNames,
}: {
	aggregate: Aggregate;
	memory: MemoryHealth;
	storage: Record<string, number>;
	recallGetRatio: number;
	projectNames: Record<string, string | null>;
}): JSX.Element {
	const totalCache =
		aggregate.cache_status.fresh +
		aggregate.cache_status.reindexed +
		aggregate.cache_status.stale;
	const pct = (n: number) =>
		totalCache === 0 ? "0%" : `${Math.round((n / totalCache) * 100)}%`;
	const topStorage = Object.entries(storage)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 3);

	if (aggregate.total === 0) {
		return (
			<Box>
				<Text>No calls in this window yet — start using ai-cortex to see data.</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Box>
				<Box borderStyle="single" paddingX={1} flexDirection="column" width={32}>
					<Text bold>Tool calls</Text>
					<Text>{aggregate.total}</Text>
					<Text>p50 {aggregate.p50}ms  p95 {aggregate.p95}ms</Text>
					<Text>err {aggregate.errs}</Text>
				</Box>
				<Box borderStyle="single" paddingX={1} flexDirection="column" width={36}>
					<Text bold>Memory</Text>
					<Text>{memory.active} active, {memory.candidate} pending</Text>
					<Text>pinned {memory.pinned}  deprecated {memory.deprecated}</Text>
					<Text>recall→get {Math.round(recallGetRatio * 100)}%</Text>
				</Box>
			</Box>
			<Box>
				<Box borderStyle="single" paddingX={1} flexDirection="column" width={32}>
					<Text bold>Cache mix</Text>
					<Text>fresh {pct(aggregate.cache_status.fresh)}</Text>
					<Text>reindexed {pct(aggregate.cache_status.reindexed)}</Text>
					<Text>stale {pct(aggregate.cache_status.stale)}</Text>
				</Box>
				<Box borderStyle="single" paddingX={1} flexDirection="column" width={36}>
					<Text bold>Storage</Text>
					{topStorage.map(([k, v]) => (
						<Text key={k}>{storageLabel(k, projectNames)} {mb(v)}</Text>
					))}
				</Box>
			</Box>
		</Box>
	);
}
