import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Box, Text, useInput } from "ink";
import {
	loadMemoryList as realLoadMemoryList,
	loadMemoryBody as realLoadMemoryBody,
	type MemoryListGroups,
	type MemoryBodyResult,
} from "../../lib/stats/memory-browser.js";
import { memoryActivity as realMemoryActivity } from "../../lib/stats/query.js";
import type { StatsWindow } from "../../lib/stats/types.js";
import { MemoryActivityStrip } from "./MemoryActivityStrip.js";
import { MemoryList } from "./MemoryList.js";
import { MemoryBodyView } from "./MemoryBodyView.js";
import { THEME } from "../theme.js";

type Deps = {
	loadMemoryList: (rk: string) => MemoryListGroups;
	memoryActivity: typeof realMemoryActivity;
	loadMemoryBody: (rk: string, id: string) => Promise<MemoryBodyResult>;
};

const DEFAULT_DEPS: Deps = {
	loadMemoryList: realLoadMemoryList,
	memoryActivity: realMemoryActivity,
	loadMemoryBody: realLoadMemoryBody,
};

export type MemoryBrowserProps = {
	repoKey: string;
	window: StatsWindow;
	onExit: () => void;
	interactive?: boolean;
	deps?: Deps;
};

type SelRow = { id: string; groupIdx: number };

function selectableRows(g: MemoryListGroups): SelRow[] {
	const out: SelRow[] = [];
	g.groups.forEach((grp, gi) => {
		for (const it of grp.items) out.push({ id: it.id, groupIdx: gi });
	});
	return out;
}

// First row index of the next non-empty group after the current selection's
// group (J), or the previous non-empty group (K). Returns the same index if
// there is no such group (no-op at the ends).
function jumpGroup(
	rows: SelRow[],
	cur: number,
	dir: 1 | -1,
): number {
	if (rows.length === 0) return 0;
	const curGroup = rows[cur]?.groupIdx ?? 0;
	if (dir === 1) {
		const idx = rows.findIndex((r) => r.groupIdx > curGroup);
		return idx >= 0 ? idx : cur;
	}
	// previous group: first row whose groupIdx is the greatest value < curGroup
	const prevGroups = rows
		.map((r) => r.groupIdx)
		.filter((g) => g < curGroup);
	if (prevGroups.length === 0) return cur;
	const target = Math.max(...prevGroups);
	return rows.findIndex((r) => r.groupIdx === target);
}

export function MemoryBrowser({
	repoKey,
	window,
	onExit,
	interactive = true,
	deps = DEFAULT_DEPS,
}: MemoryBrowserProps): JSX.Element {
	const [groups, setGroups] = useState<MemoryListGroups>(() =>
		deps.loadMemoryList(repoKey),
	);
	const [activity, setActivity] = useState(() =>
		deps.memoryActivity(repoKey, window),
	);
	const rows = useMemo(() => selectableRows(groups), [groups]);
	const ids = useMemo(() => rows.map((r) => r.id), [rows]);
	const [selIdx, setSelIdx] = useState(0);
	const [scroll, setScroll] = useState(0);
	const [body, setBody] = useState<MemoryBodyResult | null>(null);
	const memo = useRef(new Map<string, MemoryBodyResult>());

	const selectedId = ids[selIdx] ?? null;

	useEffect(() => {
		let cancelled = false;
		if (!selectedId) {
			setBody(null);
			return;
		}
		const cached = memo.current.get(selectedId);
		if (cached) {
			setBody(cached);
			setScroll(0);
			return;
		}
		void deps.loadMemoryBody(repoKey, selectedId).then((r) => {
			if (cancelled) return;
			memo.current.set(selectedId, r);
			setBody(r);
			setScroll(0);
		});
		return () => {
			cancelled = true;
		};
	}, [selectedId, repoKey, deps]);

	const reload = () => {
		const g = deps.loadMemoryList(repoKey);
		memo.current.clear();
		setGroups(g);
		setActivity(deps.memoryActivity(repoKey, window));
		const newIds = selectableRows(g).map((r) => r.id);
		const keepId = ids[selIdx];
		const keepAt = keepId ? newIds.indexOf(keepId) : -1;
		setSelIdx(keepAt >= 0 ? keepAt : Math.min(selIdx, Math.max(0, newIds.length - 1)));
	};

	useInput(
		(input, key) => {
			if (key.escape) return onExit();
			if (input === "r") return reload();
			if (key.return) return; // reserved (LLM rewrite)
			if (input === "j" || key.downArrow) {
				setSelIdx((i) => Math.min(ids.length - 1, i + 1));
			} else if (input === "k" || key.upArrow) {
				setSelIdx((i) => Math.max(0, i - 1));
			} else if (input === "J") {
				setSelIdx((i) => jumpGroup(rows, i, 1));
			} else if (input === "K") {
				setSelIdx((i) => jumpGroup(rows, i, -1));
			} else if (key.ctrl && input === "d") {
				setScroll((s) => s + 5);
			} else if (key.ctrl && input === "u") {
				setScroll((s) => Math.max(0, s - 5));
			}
		},
		{ isActive: interactive },
	);

	const name = repoKey.slice(0, 14);
	const empty = ids.length === 0 && !groups.error;

	return (
		<Box flexDirection="column">
			<Text color={THEME.accent}>
				ai-cortex · memory browser — {name}
			</Text>
			<MemoryActivityStrip
				recorded={activity.recorded}
				used={activity.used}
				recordedTotal={activity.recordedTotal}
				usedTotal={activity.usedTotal}
			/>
			{empty ? (
				<Box marginTop={1}>
					<Text dimColor>No memories for {name} yet.</Text>
				</Box>
			) : (
				<Box marginTop={1}>
					<Box width={34}>
						<MemoryList
							groups={groups}
							selectedId={selectedId}
							viewportRows={16}
						/>
					</Box>
					<Box marginLeft={2} flexGrow={1}>
						<MemoryBodyView
							record={body?.record ?? null}
							error={body?.error ?? null}
							scroll={scroll}
							viewportLines={16}
						/>
					</Box>
				</Box>
			)}
			<Text color={THEME.muted}>
				[Esc]back [j/k]row [J/K]group [^d/^u]scroll [Enter]rewrite (soon)
			</Text>
		</Box>
	);
}
