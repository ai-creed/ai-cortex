import React, { type JSX } from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.js";

export type KeyBarProps = {
	hints: Array<[string, string]>;
	statusLine?: string;
	selectedLabel?: string | null;
};

export function KeyBar({ hints, statusLine, selectedLabel }: KeyBarProps): JSX.Element {
	return (
		<Box flexDirection="column">
			{selectedLabel ? (
				<Box>
					<Text dimColor>selected: </Text>
					<Text color={THEME.accent}>{selectedLabel}</Text>
					<Text dimColor>{"        "}</Text>
					<Text bold>e</Text>
					<Text dimColor> exclude   </Text>
					<Text bold>a</Text>
					<Text dimColor> archive   </Text>
					<Text bold>x</Text>
					<Text dimColor> clean</Text>
				</Box>
			) : null}
			<Box>
				{hints.map(([k, label], i) => (
					<Box key={k}>
						{i > 0 ? <Text dimColor>{"  "}</Text> : null}
						<Text color={THEME.accent}>[{k}]</Text>
						<Text dimColor>{label}</Text>
					</Box>
				))}
				{statusLine ? <Text dimColor>{`   ${statusLine}`}</Text> : null}
			</Box>
		</Box>
	);
}
