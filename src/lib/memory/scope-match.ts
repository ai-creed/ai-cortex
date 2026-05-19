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

/**
 * Deterministic specificity score for a stored scope pattern. Higher = more
 * specific. Literal patterns (no glob chars) always outrank any glob. Among
 * globs, a longer literal prefix (string length before the first glob char)
 * dominates; the number of `**` segments is only a minor tiebreaker, so a
 * deep recursive subtree scope (e.g. `src/lib/memory/**`) still outranks a
 * shallow glob (e.g. `src/*`). Pure; normalizes separators like the matchers
 * above. An empty / normalized-empty pattern is least specific by contract.
 * Used by edit-time surfacing so an exact-path rule is never displaced by a
 * broad glob (spec §4.1).
 */
export function patternSpecificity(pattern: string): number {
	const np = normalizePath(pattern);
	if (np.length === 0) return -1;
	if (!GLOB_CHARS.test(np)) {
		// Literal: dominant tier, tie-broken by path string length.
		return 1_000_000_000 + np.length;
	}
	// Glob tier: prefix length dominates (scaled far above any realistic
	// `**` count); `**` count is a minor subtractive tiebreaker that cannot
	// invert prefix ordering.
	const firstGlob = np.search(GLOB_CHARS);
	const doubleStars = (np.match(/\*\*/g) ?? []).length;
	return firstGlob * 1000 - doubleStars;
}
