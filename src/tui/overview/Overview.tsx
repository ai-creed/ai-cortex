import React, { type JSX } from "react";
import { Box, Text, useInput } from "ink";
import type { StatsWindow } from "../../lib/stats/types.js";
import type { Aggregate, MemoryHealth } from "../../lib/stats/query.js";
import { ProjectList, type ProjectRow } from "./ProjectList.js";
import { AggregatePanels } from "./AggregatePanels.js";
import { VerdictBand } from "./VerdictBand.js";
import { THEME } from "../theme.js";

export type OverviewProps = {
	window: StatsWindow;
	projects: ProjectRow[];
	aggregate: Aggregate;
	memory: MemoryHealth;
	storage: Record<string, number>;
	projectNames: Record<string, string | null>;
	memoryUsedPct: number;
	recallToGetPct: number;
	suggestHitPct: number;
	totalSessions: number;
	selected: number;
	onSelect: (i: number) => void;
	interactive?: boolean;
};

export function Overview(p: OverviewProps): JSX.Element {
	const interactive = p.interactive !== false;
	useInput(
		(input, key) => {
			if (input === "j" || key.downArrow) p.onSelect(Math.min(p.projects.length - 1, p.selected + 1));
			else if (input === "k" || key.upArrow) p.onSelect(Math.max(0, p.selected - 1));
		},
		{ isActive: interactive },
	);

	const errPct = p.aggregate.total === 0 ? 0 : (p.aggregate.errs / p.aggregate.total) * 100;

	return (
		<Box flexDirection="column">
			<Text bold color={THEME.accent}>ai-cortex stats · {p.window}</Text>
			<VerdictBand
				memoryUsedPct={p.memoryUsedPct}
				recallToGetPct={p.recallToGetPct}
				suggestHitPct={p.suggestHitPct}
				errPct={errPct}
				totalSessions={p.totalSessions}
				totalCalls={p.aggregate.total}
			/>
			<Box>
				<ProjectList projects={p.projects} selected={p.selected} />
				<Box marginLeft={2}>
					<AggregatePanels
						aggregate={p.aggregate}
						memory={p.memory}
						storage={p.storage}
						projectNames={p.projectNames}
						memoryUsedPct={p.memoryUsedPct}
						recallToGetPct={p.recallToGetPct}
						suggestHitPct={p.suggestHitPct}
					/>
				</Box>
			</Box>
		</Box>
	);
}
