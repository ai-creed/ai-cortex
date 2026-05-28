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
	memoryUsedPct: number;
	recallToGetPct: number;
	suggestHitPct: number;
	totalSessions: number;

	selectedRepoKey: string | null;
	selectedName: string | null;
	selectedAggregate: Aggregate | null;
	selectedMemory: MemoryHealth | null;
	selectedMemoryUsedPct: number;
	selectedRecallToGetPct: number;
	selectedSuggestHitPct: number;
	selectedTotalSessions: number;

	storage: Record<string, number>;
	projectNames: Record<string, string | null>;

	selected: number;
	onSelect: (i: number) => void;
	interactive?: boolean;
};

function errPctOf(a: Aggregate | null): number {
	if (!a || a.total === 0) return 0;
	return (a.errs / a.total) * 100;
}

export function Overview(p: OverviewProps): JSX.Element {
	const interactive = p.interactive !== false;
	useInput(
		(input, key) => {
			if (input === "j" || key.downArrow) p.onSelect(Math.min(p.projects.length - 1, p.selected + 1));
			else if (input === "k" || key.upArrow) p.onSelect(Math.max(0, p.selected - 1));
		},
		{ isActive: interactive },
	);

	const overallErrPct = errPctOf(p.aggregate);
	const selectedErrPct = errPctOf(p.selectedAggregate);

	const panelAggregate = p.selectedAggregate ?? p.aggregate;
	const panelMemory = p.selectedMemory ?? p.memory;
	const panelMemoryUsedPct = p.selectedRepoKey ? p.selectedMemoryUsedPct : p.memoryUsedPct;
	const panelRecallToGetPct = p.selectedRepoKey ? p.selectedRecallToGetPct : p.recallToGetPct;
	const panelSuggestHitPct = p.selectedRepoKey ? p.selectedSuggestHitPct : p.suggestHitPct;

	const projectTitle =
		p.selectedName ?? (p.selectedRepoKey ? p.selectedRepoKey.slice(0, 14) : "");

	return (
		<Box flexDirection="column">
			<Text bold color={THEME.accent}>ai-cortex stats · {p.window}</Text>
			<VerdictBand
				title="Is ai-cortex helping? (all projects)"
				memoryUsedPct={p.memoryUsedPct}
				recallToGetPct={p.recallToGetPct}
				suggestHitPct={p.suggestHitPct}
				errPct={overallErrPct}
				totalSessions={p.totalSessions}
				totalCalls={p.aggregate.total}
			/>
			{p.selectedRepoKey && p.selectedAggregate ? (
				<VerdictBand
					title={`${projectTitle} (this project)`}
					memoryUsedPct={p.selectedMemoryUsedPct}
					recallToGetPct={p.selectedRecallToGetPct}
					suggestHitPct={p.selectedSuggestHitPct}
					errPct={selectedErrPct}
					totalSessions={p.selectedTotalSessions}
					totalCalls={p.selectedAggregate.total}
				/>
			) : null}
			<Box>
				<ProjectList projects={p.projects} selected={p.selected} />
				<Box marginLeft={2}>
					<AggregatePanels
						aggregate={panelAggregate}
						memory={panelMemory}
						storage={p.storage}
						projectNames={p.projectNames}
						memoryUsedPct={panelMemoryUsedPct}
						recallToGetPct={panelRecallToGetPct}
						suggestHitPct={panelSuggestHitPct}
					/>
				</Box>
			</Box>
		</Box>
	);
}
