import React, { useRef, useState, type JSX } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { StatsWindow } from "../lib/stats/types.js";
import { useStatsTick } from "./hooks/useStatsTick.js";
import { Overview } from "./overview/Overview.js";
import { DetailPanel, type Detail } from "./detail/DetailPanel.js";
import { KeyBar } from "./components/KeyBar.js";
import { MemoryBrowser } from "./memory/MemoryBrowser.js";
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

type Tick = { ov: Snapshot; det: Detail | null };

export function App({
	read = readAll,
	initialWindow = "7d",
	initialProject = null,
	once = false,
	termSize = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
}: AppProps): JSX.Element {
	const { exit } = useApp();
	const [window, setWindow] = useState<StatsWindow>(initialWindow);
	const [selected, setSelected] = useState(0);
	const [lastErr, setLastErr] = useState<string | null>(null);
	const [browserRepoKey, setBrowserRepoKey] = useState<string | null>(null);
	const selectedRef = useRef(0);
	selectedRef.current = selected;
	const initialProjectRef = useRef(initialProject);

	const { data: snap, refresh } = useStatsTick<Tick | null>(() => {
		try {
			const ov = read(window, null);
			const projs = ov.projects;
			if (initialProjectRef.current) {
				const idx = projs.findIndex(
					(p) => p.repoKey === initialProjectRef.current,
				);
				initialProjectRef.current = null;
				if (idx >= 0) {
					selectedRef.current = idx;
					setSelected(idx);
				}
			}
			const rk = projs[selectedRef.current]?.repoKey ?? null;
			const det: Detail | null = rk
				? (() => {
						const s = read(window, rk);
						return {
							repoKey: rk,
							aggregate: s.aggregate,
							latencyPerTool: s.latencyPerTool,
							topTools: s.topTools,
							memory: s.memory,
							storage: s.storage,
							meta: s.meta,
						};
					})()
				: null;
			setLastErr(null);
			return { ov, det };
		} catch (e) {
			setLastErr(e instanceof Error ? e.message : String(e));
			return null;
		}
	}, once ? 60_000 : 1500);

	const onSelect = (i: number) => {
		selectedRef.current = i;
		setSelected(i);
		refresh();
	};

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
		{ isActive: !once && browserRepoKey === null },
	);

	if (termSize.cols < MIN_COLS || termSize.rows < MIN_ROWS) {
		return <Text>Terminal too small — need {MIN_COLS}×{MIN_ROWS}.</Text>;
	}

	if (browserRepoKey !== null) {
		return (
			<MemoryBrowser
				repoKey={browserRepoKey}
				window={window}
				interactive={!once}
				termSize={termSize}
				onExit={() => setBrowserRepoKey(null)}
			/>
		);
	}

	if (!snap) return <Text>Loading…</Text>;

	return (
		<Box flexDirection="column">
			<Overview
				window={window}
				projects={snap.ov.projects}
				aggregate={snap.ov.aggregate}
				memory={snap.ov.memory}
				storage={snap.ov.storage}
				projectNames={snap.ov.projectNames}
				recallGetRatio={snap.ov.recallGetRatio}
				selected={selected}
				onSelect={onSelect}
				interactive={!once}
			/>
			<Box marginTop={1}>
				<DetailPanel
					detail={snap.det}
					interactive={!once && browserRepoKey === null}
					window={window}
					onOpenMemoryBrowser={
						once ? undefined : (rk) => setBrowserRepoKey(rk)
					}
				/>
			</Box>
			<KeyBar
				hints={[
					["q", "uit"],
					["r", "efresh"],
					["Tab", "tab"],
					["w", "indow"],
				]}
				statusLine={lastErr ? `last error: ${lastErr}` : undefined}
			/>
		</Box>
	);
}
