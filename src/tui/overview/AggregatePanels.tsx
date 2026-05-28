import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { Aggregate, MemoryHealth } from "../../lib/stats/query.js";
import { EffectivenessPanel } from "./EffectivenessPanel.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { THEME } from "../theme.js";

function mb(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function storageLabel(repoKey: string, projectNames: Record<string, string | null>): string {
	const raw = projectNames[repoKey] ?? repoKey.slice(0, 14);
	return raw.length > 14 ? raw.slice(0, 13) + "…" : raw.padEnd(14);
}

export type AggregatePanelsProps = {
	aggregate: Aggregate;
	memory: MemoryHealth;
	storage: Record<string, number>;
	projectNames: Record<string, string | null>;
	memoryUsedPct: number;
	recallToGetPct: number;
	suggestHitPct: number;
};

export function AggregatePanels(p: AggregatePanelsProps): JSX.Element {
	if (p.aggregate.total === 0) {
		return (
			<Box>
				<Text>No calls in this window yet — start using ai-cortex to see data.</Text>
			</Box>
		);
	}
	const topStorage = Object.entries(p.storage)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 3);
	const totalStorage = Object.values(p.storage).reduce((acc, n) => acc + n, 0);

	return (
		<Box flexDirection="column">
			<Box>
				<EffectivenessPanel
					memoryUsedPct={p.memoryUsedPct}
					recallToGetPct={p.recallToGetPct}
					suggestHitPct={p.suggestHitPct}
				/>
				<ActivityPanel
					total={p.aggregate.total}
					p50={p.aggregate.p50}
					p95={p.aggregate.p95}
					errs={p.aggregate.errs}
				/>
			</Box>
			<Box>
				<Box borderStyle="single" paddingX={1} flexDirection="column" width={32}>
					<Text bold color={THEME.accent}>Memory</Text>
					<Text>{p.memory.active} active · {p.memory.candidate} pending</Text>
					<Text>pinned {p.memory.pinned} · deprecated {p.memory.deprecated}</Text>
				</Box>
				<Box borderStyle="single" paddingX={1} flexDirection="column" width={36}>
					<Text bold color={THEME.accent}>Storage</Text>
					<Text>{mb(totalStorage)} total</Text>
					{topStorage.map(([k, v]) => (
						<Text key={k}>{storageLabel(k, p.projectNames)} {mb(v)}</Text>
					))}
				</Box>
			</Box>
		</Box>
	);
}
