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

export type Detail = {
	repoKey: string;
	aggregate: Aggregate;
	latencyPerTool: Record<string, LatencyStats>;
	topTools: ToolStat[];
	memory: MemoryHealth;
	storage: Record<string, number>;
	meta: CacheMeta;
};

const TABS = ["Tools", "Memory", "Suggest", "Storage"] as const;
type Tab = (typeof TABS)[number];

export function ProjectDetail({
	detail,
	onBack,
}: {
	detail: Detail;
	onBack: () => void;
}): JSX.Element {
	const [tab, setTab] = useState<Tab>("Tools");
	useInput((input, key) => {
		if (key.escape) return onBack();
		const i = "1234".indexOf(input);
		if (i >= 0) setTab(TABS[i]);
		if (key.tab) setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]);
	});
	return (
		<Box flexDirection="column">
			<Text bold>
				ai-cortex stats — {detail.repoKey}
			</Text>
			<Text>
				{TABS.map((t) => (t === tab ? `[ ${t}* ]` : `[ ${t} ]`)).join(" ")}
			</Text>
			<Box marginTop={1}>
				{tab === "Tools" && (
					<ToolsTab
						aggregate={detail.aggregate}
						latencyPerTool={detail.latencyPerTool}
						topTools={detail.topTools}
					/>
				)}
				{tab === "Memory" && <MemoryTab memory={detail.memory} />}
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
