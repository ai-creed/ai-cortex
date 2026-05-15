import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { MemoryHealth } from "../../lib/stats/query.js";

export function MemoryTab({ memory }: { memory: MemoryHealth }): JSX.Element {
	if (memory.active + memory.candidate === 0) return <Text>No memory data yet.</Text>;
	return (
		<Box flexDirection="column">
			<Text>active {memory.active}  candidate {memory.candidate}  pinned {memory.pinned}  deprecated {memory.deprecated}</Text>
			<Box marginTop={1}>
				<Text bold>Top accessed</Text>
			</Box>
			{memory.topAccessed.map((m) => (
				<Text key={m.id}>
					{m.id.padEnd(40)} {String(m.get_count).padStart(4)}× {m.last_accessed_at ?? "—"}
				</Text>
			))}
		</Box>
	);
}
