// src/lib/memory/scope-match.ts
import picomatch from "picomatch";

const GLOB_CHARS = /[*?[{]/;

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

/**
 * Match a stored scope pattern (literal path or glob) against a candidate path.
 * Both inputs are normalized: backslash → slash, leading `./` or `/` stripped.
 *
 * Stateless. For batch operations on the same patterns, prefer `createMatchCache()`.
 */
export function matchesScope(pattern: string, path: string): boolean {
	const np = normalizePath(pattern);
	const nx = normalizePath(path);
	if (!GLOB_CHARS.test(np)) return np === nx;
	try {
		return picomatch(np, { dot: true })(nx);
	} catch {
		return false;
	}
}

/**
 * Returns a memoized matcher. Compile cost amortized across many path checks
 * for the same pattern. Use in hot paths (surface.ts, retrieve.ts scoring loop).
 */
export function createMatchCache(): (pattern: string, path: string) => boolean {
	const cache = new Map<string, (p: string) => boolean>();
	return (pattern, path) => {
		const np = normalizePath(pattern);
		const nx = normalizePath(path);
		if (!GLOB_CHARS.test(np)) return np === nx;
		let m = cache.get(np);
		if (!m) {
			try {
				m = picomatch(np, { dot: true });
			} catch {
				m = () => false;
			}
			cache.set(np, m);
		}
		return m(nx);
	};
}
