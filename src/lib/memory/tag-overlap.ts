// src/lib/memory/tag-overlap.ts
//
// Pure primitives for tag-vs-path-token similarity, used by Tier 2 of
// `matchSurfaceMemories` (spec 2026-05-24 §4).
//
// All functions are I/O-free, deterministic, and side-effect-free.

export function stripBasicPlural(t: string): string {
	if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
	if (t.endsWith("ses") && t.length > 4) return t.slice(0, -2);
	if (t.endsWith("xes") && t.length > 4) return t.slice(0, -2);
	if (t.endsWith("ches") && t.length > 5) return t.slice(0, -2);
	if (t.endsWith("shes") && t.length > 5) return t.slice(0, -2);
	if (t.endsWith("s") && !t.endsWith("ss") && t.length > 2) return t.slice(0, -1);
	return t;
}

export function normalize(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[-_./\s]+/)
		.map(stripBasicPlural)
		.filter((t) => t.length > 1);
}

export function tagOverlapScore(
	pathTokens: Set<string>,
	memoryTags: string[],
	excludedTags: Set<string>,
): number {
	let score = 0;
	for (const tag of memoryTags) {
		// Generic/common tags do not discriminate; they were the engine of
		// incidental Tier-2 matches, so they neither count nor boost (L3).
		if (excludedTags.has(tag)) continue;
		const tagTokens = new Set(normalize(tag));
		for (const t of tagTokens) if (pathTokens.has(t)) score += 1;
	}
	return score;
}
