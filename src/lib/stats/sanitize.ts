// src/lib/stats/sanitize.ts

const SAFE_TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function safeTag(s: unknown): string | null {
	if (typeof s !== "string") return null;
	if (!SAFE_TAG_RE.test(s)) return null;
	return s;
}

export function errClassOf(err: unknown): string | null {
	if (!(err instanceof Error)) return null;
	const name = err.constructor?.name;
	return safeTag(name) ?? "Error";
}
