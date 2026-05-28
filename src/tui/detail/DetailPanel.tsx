import React, { useState, type JSX } from "react";
import { Box, Text, useInput } from "ink";
import type {
	Aggregate,
	CacheMeta,
	LatencyStats,
	MemoryHealth,
	ToolStat,
} from "../../lib/stats/query.js";
import { ToolsTab } from "./ToolsTab.js";
import { MemoryTab } from "./MemoryTab.js";
import { SuggestTab } from "./SuggestTab.js";
import { StorageTab } from "./StorageTab.js";
import { SessionsTab } from "./SessionsTab.js";
import type { StatsWindow } from "../../lib/stats/types.js";
import type { AdoptionSummary, SessionRow } from "../../lib/stats/sessions.js";
import { THEME } from "../theme.js";

export type Detail = {
	repoKey: string;
	aggregate: Aggregate;
	latencyPerTool: Record<string, LatencyStats>;
	topTools: ToolStat[];
	memory: MemoryHealth;
	storage: Record<string, number>;
	meta: CacheMeta;
	adoption: { sessions: SessionRow[]; summary: AdoptionSummary };
	suggestHit: number;
};

const TABS = ["Effectiveness", "Tools", "Memory", "Suggest", "Storage"] as const;
type Tab = (typeof TABS)[number];

export function DetailPanel({
	detail,
	interactive = true,
	window: windowProp = "7d",
	onOpenMemoryBrowser,
}: {
	detail: Detail | null;
	interactive?: boolean;
	window?: StatsWindow;
	onOpenMemoryBrowser?: (repoKey: string) => void;
}): JSX.Element {
	const [tab, setTab] = useState<Tab>("Effectiveness");
	useInput(
		(input, key) => {
			if (
				key.return &&
				tab === "Memory" &&
				detail &&
				onOpenMemoryBrowser
			) {
				onOpenMemoryBrowser(detail.repoKey);
				return;
			}
			const i = "12345".indexOf(input);
			if (i >= 0) setTab(TABS[i]);
			if (key.tab) setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]);
		},
		{ isActive: interactive },
	);

	if (!detail) {
		return <Text dimColor>Select a project (j/k)</Text>;
	}

	const name = detail.meta.name ?? detail.repoKey.slice(0, 14);
	return (
		<Box flexDirection="column">
			<Text color={THEME.accent}>── {name} ──────────────────</Text>
			<Text>
				{TABS.map((t, i) => (
					<React.Fragment key={t}>
						{i > 0 ? " " : ""}
						{t === tab ? (
							<Text color={THEME.accent}>[ {t}* ]</Text>
						) : (
							<Text>[ {t} ]</Text>
						)}
					</React.Fragment>
				))}
			</Text>
			<Box marginTop={1}>
				{tab === "Effectiveness" && (
					<SessionsTab adoption={detail.adoption} window={windowProp} />
				)}
				{tab === "Tools" && (
					<ToolsTab
						aggregate={detail.aggregate}
						latencyPerTool={detail.latencyPerTool}
						topTools={detail.topTools}
					/>
				)}
				{tab === "Memory" && (
					<MemoryTab
						memory={detail.memory}
						repoKey={detail.repoKey}
						window={windowProp}
					/>
				)}
				{tab === "Suggest" && <SuggestTab aggregate={detail.aggregate} />}
				{tab === "Storage" && (
					<StorageTab
						repoKey={detail.repoKey}
						storage={detail.storage}
						meta={detail.meta}
					/>
				)}
			</Box>
		</Box>
	);
}
