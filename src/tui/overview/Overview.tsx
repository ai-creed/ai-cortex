import React, { type JSX } from "react";
import { Box, Text, useInput } from "ink";
import type { StatsWindow } from "../../lib/stats/types.js";
import type { Aggregate, MemoryHealth } from "../../lib/stats/query.js";
import { ProjectList, type ProjectRow } from "./ProjectList.js";
import { AggregatePanels } from "./AggregatePanels.js";

export type OverviewProps = {
	window: StatsWindow;
	projects: ProjectRow[];
	aggregate: Aggregate;
	memory: MemoryHealth;
	storage: Record<string, number>;
	recallGetRatio: number;
	selected: number;
	onSelect: (i: number) => void;
	onEnter: (repoKey: string) => void;
	interactive?: boolean;
};

export function Overview(p: OverviewProps): JSX.Element {
	const interactive = p.interactive !== false;
	useInput(
		(input, key) => {
			if (input === "j" || key.downArrow) {
				p.onSelect(Math.min(p.projects.length - 1, p.selected + 1));
			} else if (input === "k" || key.upArrow) {
				p.onSelect(Math.max(0, p.selected - 1));
			} else if (key.return && p.projects[p.selected]) {
				p.onEnter(p.projects[p.selected].repoKey);
			}
		},
		{ isActive: interactive },
	);

	return (
		<Box flexDirection="column">
			<Text bold>ai-cortex stats — overview · {p.window}</Text>
			<Box>
				<ProjectList projects={p.projects} selected={p.selected} />
				<Box marginLeft={2}>
					<AggregatePanels
						aggregate={p.aggregate}
						memory={p.memory}
						storage={p.storage}
						recallGetRatio={p.recallGetRatio}
					/>
				</Box>
			</Box>
		</Box>
	);
}
