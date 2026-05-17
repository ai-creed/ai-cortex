// src/tui/memory/MemoryList.tsx
import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { MemoryListGroups } from "../../lib/stats/memory-browser.js";
import { THEME, typeColor } from "../theme.js";

export type MemoryListProps = {
	groups: MemoryListGroups;
	selectedId: string | null;
	viewportRows: number;
};

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
}: MemoryListProps): JSX.Element {
	if (groups.error) {
		return <Text color={THEME.err}>⚠ memory index unavailable</Text>;
	}
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
		<Box flexDirection="column">
			{visible.map((l, i) => {
				if (l.kind === "header") {
					return (
						<Text key={`h${start + i}`} bold color={THEME.muted}>
							{l.status.toUpperCase()} ({l.count})
						</Text>
					);
				}
				const sel = l.id === selectedId;
				return (
					<Text
						key={l.id}
						backgroundColor={sel ? THEME.accent : undefined}
						color={sel ? "black" : undefined}
					>
						{l.pinned ? "📌 " : "  "}
						<Text color={sel ? "black" : typeColor(l.type)}>
							[{l.type}]
						</Text>{" "}
						{l.title}
					</Text>
				);
			})}
		</Box>
	);
}
