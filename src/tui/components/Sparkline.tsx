import React, { type JSX } from "react";
import { Text } from "ink";

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export type SparklineProps = {
	values: number[];
	width: number;
	color?: string;
};

function bucket(values: number[], width: number): number[] {
	if (values.length <= width) return values;
	const out: number[] = [];
	const step = values.length / width;
	for (let i = 0; i < width; i++) {
		const start = Math.floor(i * step);
		const end = Math.floor((i + 1) * step);
		const slice = values.slice(start, Math.max(end, start + 1));
		out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
	}
	return out;
}

export function Sparkline({ values, width, color }: SparklineProps): JSX.Element {
	if (values.length === 0) {
		return color === undefined ? (
			<Text>{"·".repeat(width)}</Text>
		) : (
			<Text color={color}>{"·".repeat(width)}</Text>
		);
	}
	const sampled = bucket(values, width);
	const max = Math.max(...sampled);
	const chars = sampled.map((v) => {
		if (max === 0) return BLOCKS[0];
		const idx = Math.min(BLOCKS.length - 1, Math.floor((v / max) * BLOCKS.length));
		return BLOCKS[idx];
	});
	const joined = chars.join("");
	return color === undefined ? (
		<Text>{joined}</Text>
	) : (
		<Text color={color}>{joined}</Text>
	);
}
