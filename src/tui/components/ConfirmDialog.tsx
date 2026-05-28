import React, { type JSX } from "react";
import { Box, Text, useInput } from "ink";
import { THEME } from "../theme.js";

export type ConfirmDialogProps = {
	title: string;
	body: string[];
	danger: string;
	onConfirm: () => void;
	onCancel: () => void;
};

export function ConfirmDialog(p: ConfirmDialogProps): JSX.Element {
	useInput((input, key) => {
		if (input === "y" || key.return) p.onConfirm();
		else if (input === "n" || key.escape) p.onCancel();
	});
	return (
		<Box borderStyle="single" flexDirection="column" paddingX={1}>
			<Text bold color={THEME.err}>{p.title}</Text>
			{p.body.map((line, i) => <Text key={i}>{line}</Text>)}
			<Text> </Text>
			<Text color={THEME.err}>{p.danger}</Text>
			<Text> </Text>
			<Text>        [ y ] delete        [ n ] cancel</Text>
		</Box>
	);
}
