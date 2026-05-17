// src/tui/memory/MemoryList.tsx
import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { MemoryListGroups } from "../../lib/stats/memory-browser.js";
import { THEME, typeColor } from "../theme.js";

export type MemoryListProps = {
	groups: MemoryListGroups;
	selectedId: string | null;
	viewportRows: number;
	/** inner content width available for a row (sidebar box width − 2 borders). */
	width: number;
};

const MARKER_W = 3;
const TYPE_W = 13;

// Hard-truncate to `w` columns, appending an ellipsis when it overflows.
function clip(s: string, w: number): string {
	if (w <= 0) return "";
	if (s.length <= w) return s;
	if (w === 1) return "…";
	return s.slice(0, w - 1) + "…";
}

// Fit to exactly `w` columns: truncate when long, right-pad when short.
function fit(s: string, w: number): string {
	return clip(s, w).padEnd(Math.max(0, w));
}

type Line =
	| { kind: "header"; status: string; count: number }
	| {
			kind: "row";
			id: string;
			type: string;
			title: string;
			pinned: boolean;
	  };

function flatten(groups: MemoryListGroups): Line[] {
	const out: Line[] = [];
	for (const g of groups.groups) {
		out.push({ kind: "header", status: g.status, count: g.count });
		for (const it of g.items) {
			out.push({
				kind: "row",
				id: it.id,
				type: it.type,
				title: it.title,
				pinned: it.pinned,
			});
		}
	}
	return out;
}

export function MemoryList({
	groups,
	selectedId,
	viewportRows,
	width,
}: MemoryListProps): JSX.Element {
	if (groups.error) {
		return (
			<Box flexDirection="column" borderStyle="single" borderColor={THEME.muted}>
				<Text color={THEME.err}>⚠ memory index unavailable</Text>
			</Box>
		);
	}
	const titleW = Math.max(0, width - MARKER_W - TYPE_W - 1);
	const lines = flatten(groups);
	const selIdx = lines.findIndex(
		(l) => l.kind === "row" && l.id === selectedId,
	);
	// windowed viewport centered on the selection
	let start = 0;
	if (selIdx >= 0 && lines.length > viewportRows) {
		start = Math.min(
			Math.max(0, selIdx - Math.floor(viewportRows / 2)),
			lines.length - viewportRows,
		);
	}
	const visible = lines.slice(start, start + viewportRows);
	return (
		<Box flexDirection="column" borderStyle="single" borderColor={THEME.muted}>
			{visible.map((l, i) => {
				if (l.kind === "header") {
					return (
						<Text key={`h${start + i}`} bold color={THEME.muted}>
							{clip(`${l.status.toUpperCase()} (${l.count})`, width)}
						</Text>
					);
				}
				const sel = l.id === selectedId;
				const marker = sel ? "▸  " : l.pinned ? "📌 " : "   ";
				const tag = fit(`[${l.type}]`, TYPE_W);
				const title = clip(l.title, titleW);
				if (sel) {
					// Pad the whole line to `width` so the highlight fills the row.
					const line = (marker + tag + " " + title).padEnd(width);
					return (
						<Text
							key={l.id}
							backgroundColor={THEME.accent}
							color="black"
						>
							{line}
						</Text>
					);
				}
				return (
					<Text key={l.id}>
						{marker}
						<Text color={typeColor(l.type)}>{tag}</Text> {title}
					</Text>
				);
			})}
		</Box>
	);
}
