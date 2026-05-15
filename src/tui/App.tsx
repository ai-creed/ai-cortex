import React, { useState, type JSX } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { StatsWindow } from "../lib/stats/types.js";
import { useStatsTick } from "./hooks/useStatsTick.js";
import { Overview } from "./overview/Overview.js";
import { ProjectDetail, type Detail } from "./detail/ProjectDetail.js";
import { KeyBar } from "./components/KeyBar.js";
import { readAll, type Snapshot } from "./readAll.js";

const MIN_COLS = 80;
const MIN_ROWS = 24;

export type AppProps = {
	read?: (w: StatsWindow, focus: string | null) => Snapshot;
	initialWindow?: StatsWindow;
	initialProject?: string | null;
	once?: boolean;
	termSize?: { cols: number; rows: number };
};

export function App({
	read = readAll,
	initialWindow = "7d",
	initialProject = null,
	once = false,
	termSize = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
}: AppProps): JSX.Element {
	const { exit } = useApp();
	const [window, setWindow] = useState<StatsWindow>(initialWindow);
	const [focus, setFocus] = useState<string | null>(initialProject);
	const [selected, setSelected] = useState(0);
	const [lastErr, setLastErr] = useState<string | null>(null);

	const { data: snap, refresh } = useStatsTick(() => {
		try {
			const s = read(window, focus);
			setLastErr(null);
			return s;
		} catch (e) {
			setLastErr(e instanceof Error ? e.message : String(e));
			return null;
		}
	}, once ? 60_000 : 1500);

	useInput(
		(input) => {
			if (input === "q") exit();
			if (input === "r") refresh();
			if (input === "w") {
				const order: StatsWindow[] = ["1h", "24h", "7d", "30d"];
				const i = order.indexOf(window);
				setWindow(order[(i + 1) % order.length]);
			}
		},
		{ isActive: !once },
	);

	if (termSize.cols < MIN_COLS || termSize.rows < MIN_ROWS) {
		return <Text>Terminal too small — need {MIN_COLS}×{MIN_ROWS}.</Text>;
	}

	if (!snap) return <Text>Loading…</Text>;

	const detail: Detail | null = focus
		? {
				repoKey: focus,
				aggregate: snap.aggregate,
				latencyPerTool: snap.latencyPerTool,
				topTools: snap.topTools,
				memory: snap.memory,
				storage: snap.storage,
				meta: snap.meta,
			}
		: null;

	return (
		<Box flexDirection="column">
			{detail ? (
				<ProjectDetail
					detail={detail}
					onBack={() => setFocus(null)}
					interactive={!once}
				/>
			) : (
				<Overview
					window={window}
					projects={snap.projects}
					aggregate={snap.aggregate}
					memory={snap.memory}
					storage={snap.storage}
					recallGetRatio={snap.recallGetRatio}
					selected={selected}
					onSelect={setSelected}
					onEnter={(rk) => setFocus(rk)}
					interactive={!once}
				/>
			)}
			<KeyBar
				hints={
					detail
						? [["Esc", "back"], ["1-4", "tab"], ["q", "uit"]]
						: [["q", "uit"], ["r", "efresh"], ["Enter", " drill"], ["w", "indow"]]
				}
				statusLine={lastErr ? `last error: ${lastErr}` : undefined}
			/>
		</Box>
	);
}
