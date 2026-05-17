import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { MemoryHealth } from "../../lib/stats/query.js";
import { memoryActivity as realMemoryActivity } from "../../lib/stats/query.js";
import type { StatsWindow } from "../../lib/stats/types.js";
import { Sparkline } from "../components/Sparkline.js";
import { THEME } from "../theme.js";

export type MemoryTabProps = {
	memory: MemoryHealth;
	repoKey: string;
	window: StatsWindow;
	activityFn?: typeof realMemoryActivity;
};

export function MemoryTab({
	memory,
	repoKey,
	window,
	activityFn = realMemoryActivity,
}: MemoryTabProps): JSX.Element {
	const act = activityFn(repoKey, window);
	const noMemories =
		memory.active + memory.candidate + memory.deprecated === 0;
	if (noMemories && act.recordedTotal === 0 && act.usedTotal === 0) {
		return <Text dimColor>No memory data yet.</Text>;
	}
	return (
		<Box flexDirection="column">
			<Text bold color={THEME.accent}>
				Memory · {window}
			</Text>
			<Text>
				active {memory.active}   candidate {memory.candidate}   pinned{" "}
				{memory.pinned}   deprecated {memory.deprecated}
			</Text>
			<Box marginTop={1}>
				<Text color={THEME.ok}>recorded </Text>
				<Sparkline values={act.recorded} width={30} />
				<Text> {act.recordedTotal}</Text>
			</Box>
			<Box>
				<Text color={THEME.accent}>used     </Text>
				<Sparkline values={act.used} width={30} />
				<Text> {act.usedTotal}</Text>
			</Box>
			<Box marginTop={1}>
				<Text bold color={THEME.accent}>
					Top accessed
				</Text>
			</Box>
			{memory.topAccessed.map((m) => (
				<Text key={m.id}>
					{m.id.padEnd(40)} {String(m.get_count).padStart(4)}×{" "}
					{m.last_accessed_at ?? "—"}
				</Text>
			))}
			<Text color={THEME.muted}>
				recorded = new memories (audit) · used = get/recall calls
			</Text>
		</Box>
	);
}
