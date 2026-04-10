export async function measure<T>(
	label: string,
	fn: () => Promise<T> | T
): Promise<{ label: string; durationMs: number; value: T }> {
	const start = performance.now();
	const value = await fn();
	return {
		label,
		durationMs: performance.now() - start,
		value
	};
}
