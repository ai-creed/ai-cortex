import React, { type JSX } from "react";
import { Box, Text } from "ink";

export type ProjectRow = { repoKey: string; calls: number };

export function ProjectList({
	projects,
	selected,
}: {
	projects: ProjectRow[];
	selected: number;
}): JSX.Element {
	return (
		<Box flexDirection="column" width={28}>
			<Text bold>Projects ({projects.length})</Text>
			{projects.map((p, i) => (
				<Text key={p.repoKey} inverse={i === selected}>
					{i === selected ? "▸ " : "  "}
					{p.repoKey.slice(0, 14).padEnd(14)} {String(p.calls).padStart(6)}
				</Text>
			))}
		</Box>
	);
}
