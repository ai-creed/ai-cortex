import React, { type JSX } from "react";
import { Box, Text, useInput } from "ink";
import type { StatsWindow } from "../../lib/stats/types.js";

const ORDER: StatsWindow[] = ["1h", "24h", "7d", "30d"];

export type WindowPickerProps = {
	current: StatsWindow;
	onSelect: (w: StatsWindow) => void;
};

export function WindowPicker({ current, onSelect }: WindowPickerProps): JSX.Element {
	useInput((input) => {
		const i = "1234".indexOf(input);
		if (i >= 0) onSelect(ORDER[i]);
	});
	return (
		<Box flexDirection="column" borderStyle="single" paddingX={1}>
			<Text bold>Window</Text>
			{ORDER.map((w, i) => (
				<Text key={w}>
					{w === current ? "▸" : " "} [{i + 1}] {w}
				</Text>
			))}
		</Box>
	);
}
