import React, { useEffect, type JSX } from "react";
import { Text } from "ink";
import { THEME } from "../theme.js";

export type ToastProps = {
	message: string | null;
	onDismiss: () => void;
	ms?: number;
};

export function Toast({ message, onDismiss, ms = 3000 }: ToastProps): JSX.Element | null {
	useEffect(() => {
		if (message === null) return;
		const id = setTimeout(onDismiss, ms);
		return () => clearTimeout(id);
	}, [message, ms, onDismiss]);
	if (message === null) return null;
	return <Text color={THEME.ok}>{message}</Text>;
}
