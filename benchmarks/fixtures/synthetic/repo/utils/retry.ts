export async function retry<T>(
	fn: () => Promise<T>,
	maxAttempts: number = 3,
	delayMs: number = 100,
): Promise<T> {
	let lastError: Error | undefined;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (i < maxAttempts - 1) {
				await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
			}
		}
	}
	throw lastError;
}
