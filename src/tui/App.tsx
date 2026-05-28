import React, { useRef, useState, type JSX } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { StatsWindow } from "../lib/stats/types.js";
import { useStatsTick } from "./hooks/useStatsTick.js";
import { Overview } from "./overview/Overview.js";
import { DetailPanel, type Detail } from "./detail/DetailPanel.js";
import { KeyBar } from "./components/KeyBar.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { Toast } from "./components/Toast.js";
import { MemoryBrowser } from "./memory/MemoryBrowser.js";
import { readAll, type Snapshot } from "./readAll.js";
import {
	excludeWorkspace,
	archiveWorkspace,
	cleanWorkspace,
} from "../lib/stats/hygiene.js";
import { statsConfigPath, archiveDir } from "../lib/stats/paths.js";

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
	const [helpOpen, setHelpOpen] = useState(false);
	const [confirm, setConfirm] = useState<null | {
		repoKey: string;
		label: string;
		calls: number;
		bytes: number;
		path: string | null;
	}>(null);
	const [toast, setToast] = useState<string | null>(null);
	const selectedRef = useRef(0);
	selectedRef.current = selected;
	const initialProjectRef = useRef(initialProject);

	const { data: snap, refresh } = useStatsTick<Tick | null>(() => {
		try {
			const ov = read(window, null);
			const projs = ov.projects;
			if (initialProjectRef.current) {
				const idx = projs.findIndex((p) => p.repoKey === initialProjectRef.current);
				initialProjectRef.current = null;
				if (idx >= 0) { selectedRef.current = idx; setSelected(idx); }
			}
			const rk = projs[selectedRef.current]?.repoKey ?? null;
			const det: Detail | null = rk ? (() => {
				const s = read(window, rk);
				return {
					repoKey: rk,
					aggregate: s.aggregate, latencyPerTool: s.latencyPerTool,
					topTools: s.topTools, memory: s.memory, storage: s.storage,
					meta: s.meta, adoption: s.adoption,
				};
			})() : null;
			setLastErr(null);
			return { ov, det };
		} catch (e) {
			setLastErr(e instanceof Error ? e.message : String(e));
			return null;
		}
	}, once ? 60_000 : 1500);

	const onSelect = (i: number) => { selectedRef.current = i; setSelected(i); refresh(); };

	const moveSelectionAfterRemoval = (idx: number, newLen: number) => {
		if (newLen === 0) { setSelected(0); return; }
		setSelected(Math.min(idx, newLen - 1));
	};

	useInput(
		(input, key) => {
			if (confirm !== null) return;
			if (input === "?") { setHelpOpen((v) => !v); return; }
			if (helpOpen) { if (key.escape) setHelpOpen(false); return; }
			if (input === "q") exit();
			else if (input === "r") refresh();
			else if (input === "w") {
				const order: StatsWindow[] = ["1h", "24h", "7d", "30d"];
				const i = order.indexOf(window);
				setWindow(order[(i + 1) % order.length]);
			} else {
				const proj = snap?.ov.projects[selectedRef.current];
				if (!proj) return;
				if (input === "e") {
					try {
						excludeWorkspace(proj.repoKey);
						setToast(`✓ excluded ${proj.name ?? proj.repoKey.slice(0, 14)} — edit ${statsConfigPath()} to restore.`);
						moveSelectionAfterRemoval(selectedRef.current, (snap?.ov.projects.length ?? 1) - 1);
						refresh();
					} catch (e) {
						setToast(`error: ${(e as Error).message}`);
					}
				} else if (input === "a") {
					try {
						archiveWorkspace(proj.repoKey);
						setToast(`✓ archived ${proj.repoKey} — moved to ${archiveDir(proj.repoKey)}`);
						moveSelectionAfterRemoval(selectedRef.current, (snap?.ov.projects.length ?? 1) - 1);
						refresh();
					} catch (e) {
						setToast(`error: ${(e as Error).message}`);
					}
				} else if (input === "x") {
					// Spec §confirm dialog (line 243): "Origin path comes from
					// cacheMeta when available; otherwise omitted." Source is
					// CacheMeta.worktreePath, populated by deriveCacheMeta
					// from the main cache JSON. Old sidecars (pre-v0.12) may
					// lack the field; in that case the path is null and the
					// dialog omits the path segment.
					const bytes = snap?.ov.storage[proj.repoKey] ?? 0;
					const det = snap?.det;
					const worktreePath =
						det && det.repoKey === proj.repoKey
							? det.meta.worktreePath
							: null;
					setConfirm({
						repoKey: proj.repoKey,
						label: proj.name ?? proj.repoKey,
						calls: proj.calls,
						bytes,
						path: worktreePath,
					});
				}
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
				repoKey={browserRepoKey} window={window}
				interactive={!once} termSize={termSize}
				onExit={() => setBrowserRepoKey(null)}
			/>
		);
	}

	if (!snap) return <Text>Loading…</Text>;

	const selProj = snap.ov.projects[selected];

	return (
		<Box flexDirection="column">
			<Overview
				window={window}
				projects={snap.ov.projects}
				aggregate={snap.ov.aggregate}
				memory={snap.ov.memory}
				storage={snap.ov.storage}
				projectNames={snap.ov.projectNames}
				memoryUsedPct={snap.ov.adoption.summary.memoryUsedPct}
				recallToGetPct={snap.ov.adoption.summary.recallToGetPct}
				suggestHitPct={snap.ov.suggestHit * 100}
				totalSessions={snap.ov.adoption.summary.sessionCount}
				selected={selected}
				onSelect={onSelect}
				interactive={!once && !helpOpen && confirm === null}
			/>
			<Box marginTop={1}>
				<DetailPanel
					detail={snap.det}
					interactive={!once && browserRepoKey === null && !helpOpen && confirm === null}
					window={window}
					onOpenMemoryBrowser={once ? undefined : (rk) => setBrowserRepoKey(rk)}
				/>
			</Box>
			{helpOpen && <HelpOverlay />}
			{confirm && (
				<ConfirmDialog
					title="Clean workspace?"
					body={[
						"Permanently delete cached stats + index for",
						`  ${confirm.label}   ${confirm.calls} calls${
							confirm.path ? ` · ${confirm.path}` : ""
						} · ${(confirm.bytes / 1_000_000).toFixed(1)} MB`,
					]}
					danger={`This deletes the cache dir (frees ~${(
						confirm.bytes / 1_000_000
					).toFixed(1)} MB) and cannot be undone.`}
					onConfirm={() => {
						try {
							cleanWorkspace(confirm.repoKey);
							setToast(`✓ cleaned ${confirm.label}`);
							moveSelectionAfterRemoval(selectedRef.current, (snap?.ov.projects.length ?? 1) - 1);
						} catch (e) {
							setToast(`error: ${(e as Error).message}`);
						} finally {
							setConfirm(null);
							refresh();
						}
					}}
					onCancel={() => setConfirm(null)}
				/>
			)}
			<KeyBar
				hints={[
					["q", "uit"], ["r", "efresh"], ["j/k", "nav"], ["Tab", "tab"], ["w", "indow"], ["?", "help"],
				]}
				selectedLabel={selProj ? selProj.name ?? selProj.repoKey.slice(0, 14) : null}
				statusLine={lastErr ? `last error: ${lastErr}` : undefined}
			/>
			<Toast message={toast} onDismiss={() => setToast(null)} />
		</Box>
	);
}
