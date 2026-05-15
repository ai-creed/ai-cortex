import React, { type JSX } from "react";
import { Text } from "ink";

export type KeyBarProps = {
	hints: Array<[string, string]>;
	statusLine?: string;
};

export function KeyBar({ hints, statusLine }: KeyBarProps): JSX.Element {
	const text = hints.map(([k, label]) => `[${k}]${label}`).join("  ");
	return (
		<Text dimColor>
			{text}
			{statusLine ? `   ${statusLine}` : ""}
		</Text>
	);
}
