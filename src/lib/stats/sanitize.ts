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

const MAX_MESSAGE = 300;

/**
 * Sanitize a free-form message for storage in the stats `meta` column: collapse
 * all whitespace (newlines, tabs, runs of spaces) to single spaces, trim, and
 * truncate to MAX_MESSAGE chars (trailing ellipsis). Returns null for
 * non-strings or empty/whitespace-only input. Punctuation (e.g. hyphens in
 * "how-to") is left intact.
 */
export function safeMessage(s: unknown): string | null {
	if (typeof s !== "string") return null;
	const cleaned = s.replace(/\s+/g, " ").trim();
	if (cleaned.length === 0) return null;
	if (cleaned.length <= MAX_MESSAGE) return cleaned;
	return cleaned.slice(0, MAX_MESSAGE - 1) + "…";
}

/** Sanitized message of an Error (the "why" of a failed tool call). */
export function errMessageOf(err: unknown): string | null {
	if (!(err instanceof Error)) return null;
	return safeMessage(err.message);
}

/** A tag-safe error `.code` when present (e.g. SqliteError -> "SQLITE_ERROR"). */
export function errCodeOf(err: unknown): string | null {
	const code = (err as { code?: unknown } | null)?.code;
	return safeTag(code);
}
