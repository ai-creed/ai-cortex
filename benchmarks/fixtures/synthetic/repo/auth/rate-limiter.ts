const attempts = new Map<string, { count: number; lastAttempt: number }>();

export function checkRateLimit(key: string, maxAttempts: number = 5, windowMs: number = 60000): boolean {
	const entry = attempts.get(key);
	const now = Date.now();
	if (!entry || now - entry.lastAttempt > windowMs) {
		attempts.set(key, { count: 1, lastAttempt: now });
		return true;
	}
	entry.count++;
	entry.lastAttempt = now;
	return entry.count <= maxAttempts;
}

export function resetRateLimit(key: string): void {
	attempts.delete(key);
}
