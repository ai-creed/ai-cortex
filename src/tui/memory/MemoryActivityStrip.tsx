// src/tui/memory/MemoryActivityStrip.tsx
import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { Sparkline } from "../components/Sparkline.js";
import { THEME } from "../theme.js";

export type MemoryActivityStripProps = {
	recorded: number[];
	used: number[];
	recordedTotal: number;
	usedTotal: number;
};

export function MemoryActivityStrip({
	recorded,
	used,
	recordedTotal,
	usedTotal,
}: MemoryActivityStripProps): JSX.Element {
	return (
		<Box flexDirection="column">
			<Box>
				<Text color={THEME.ok}>rec </Text>
				<Sparkline values={recorded} width={16} />
				<Text> {recordedTotal}</Text>
			</Box>
			<Box>
				<Text color={THEME.accent}>use </Text>
				<Sparkline values={used} width={16} />
				<Text> {usedTotal}</Text>
			</Box>
		</Box>
	);
}
