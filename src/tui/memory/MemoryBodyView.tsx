// src/tui/memory/MemoryBodyView.tsx
import React, { type JSX } from "react";
import { Box, Text } from "ink";
// MemoryRecord is re-exported by the stats-reader layer; the TUI must not
// import from src/lib/memory/* directly (spec constraint, Task 12 test).
import type { MemoryRecord } from "../../lib/stats/memory-browser.js";
import { THEME, typeColor } from "../theme.js";

export type MemoryBodyViewProps = {
	record: MemoryRecord | null;
	error: string | null;
	scroll: number;
	viewportLines: number;
	/** inner content width of the body box (box width − 2 borders). */
	width: number;
};

export function MemoryBodyView({
	record,
	error,
	scroll,
	viewportLines,
	width,
}: MemoryBodyViewProps): JSX.Element {
	if (error) {
		return (
			<Box flexDirection="column" borderStyle="single" borderColor={THEME.muted}>
				<Text color={THEME.err}>⚠ {error}</Text>
			</Box>
		);
	}
	if (!record) {
		return (
			<Box flexDirection="column" borderStyle="single" borderColor={THEME.muted}>
				<Text dimColor>No memory selected</Text>
			</Box>
		);
	}
	const fm = record.frontmatter;
	const scopeBits = [
		...(fm.scope?.files ?? []),
		...(fm.scope?.tags ?? []),
	];
	const scopeStr = scopeBits.length ? scopeBits.join(", ") : "(none)";
	const updated = fm.updatedAt.slice(0, 10);
	const bodyLines = record.body.split("\n");
	const maxScroll = Math.max(0, bodyLines.length - viewportLines);
	const clamped = Math.min(Math.max(0, scroll), maxScroll);
	const window = bodyLines.slice(clamped, clamped + viewportLines);
	const hasMore = clamped + viewportLines < bodyLines.length;
	return (
		<Box flexDirection="column" borderStyle="single" borderColor={THEME.muted}>
			<Text>
				<Text color={typeColor(fm.type)}>{fm.type}</Text> · {fm.status}
				{fm.pinned ? " · pinned" : ""} · {updated}
			</Text>
			<Text color={THEME.muted}>scope: {scopeStr}</Text>
			<Text color={THEME.muted}>{"─".repeat(Math.max(0, width))}</Text>
			{window.map((ln, i) => (
				<Text key={clamped + i}>{ln}</Text>
			))}
			{hasMore ? (
				<Text color={THEME.muted}>↓ more (Ctrl+d / Ctrl+u)</Text>
			) : null}
		</Box>
	);
}
