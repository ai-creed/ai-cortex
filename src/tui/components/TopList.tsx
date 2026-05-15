import React, { type JSX } from "react";
import { Box, Text } from "ink";

export type TopListProps = {
	items: Array<[string, string]>;
	empty?: string;
};

export function TopList({ items, empty = "—" }: TopListProps): JSX.Element {
	if (items.length === 0) return <Text>{empty}</Text>;
	const labelW = Math.max(...items.map(([k]) => k.length));
	return (
		<Box flexDirection="column">
			{items.map(([k, v], i) => (
				<Text key={i}>
					{k.padEnd(labelW)} {v}
				</Text>
			))}
		</Box>
	);
}
