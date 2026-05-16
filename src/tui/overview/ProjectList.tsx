import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.js";

export type ProjectRow = { repoKey: string; name: string | null; calls: number };

function label(p: ProjectRow): string {
	// Names are preferred; fall back to the repoKey's first 14 hex chars so the
	// row never collapses to an empty string when packageMeta is missing.
	const raw = p.name ?? p.repoKey.slice(0, 14);
	return raw.length > 14 ? raw.slice(0, 13) + "…" : raw.padEnd(14);
}

export function ProjectList({
	projects,
	selected,
}: {
	projects: ProjectRow[];
	selected: number;
}): JSX.Element {
	return (
		<Box flexDirection="column" width={28}>
			<Text bold color={THEME.accent}>
				Projects ({projects.length})
			</Text>
			{projects.map((p, i) =>
				i === selected ? (
					<Text
						key={p.repoKey}
						color="black"
						backgroundColor={THEME.accent}
					>
						{"▸ "}
						{label(p)} {String(p.calls).padStart(6)}
					</Text>
				) : (
					<Text key={p.repoKey}>
						{"  "}
						{label(p)} {String(p.calls).padStart(6)}
					</Text>
				),
			)}
		</Box>
	);
}
