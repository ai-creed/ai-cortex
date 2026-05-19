// src/lib/memory/surface-core.ts
import type { RetrieveHandle } from "./retrieve.js";
import { filterCandidates } from "./retrieve.js";
import { createMatchCache, patternSpecificity } from "./scope-match.js";

export type SurfacePointer = {
	id: string;
	title: string;
	type: string;
	/** The target path (one of the inputs) this memory matched. */
	path: string;
};

const POOL = 10_000;
const CAP = 3;

type Ranked = SurfacePointer & {
	_spec: number;
	_getCount: number;
	_updatedAt: string;
};

/**
 * Deterministic, project-tier, scopeFiles-only matcher for edit-time
 * surfacing (spec §4, §4.1). For each active memory whose file scope
 * (literal or glob) covers one of `relPaths`, emit a pointer. Unscoped
 * and tag-only memories are excluded by design. Ranked precision-first:
 * pattern specificity → getCount → recency. Capped at 3 total. No
 * embedding, no model load. Never bumps usage counters.
 */
export function matchSurfaceMemories(
	rh: RetrieveHandle,
	relPaths: string[],
): SurfacePointer[] {
	if (relPaths.length === 0) return [];

	const candidates = filterCandidates(rh, {
		includeStatus: ["active"],
		scope: { files: relPaths },
		candidatePoolSize: POOL,
	});
	if (candidates.length === 0) return [];

	const matcher = createMatchCache();
	const ranked: Ranked[] = [];

	for (const c of candidates) {
		const fileScopes = rh.index
			.scopeRows(c.id)
			.filter((s) => s.kind === "file")
			.map((s) => s.value);
		if (fileScopes.length === 0) continue; // exclude unscoped/tag-only

		let bestSpec = -Infinity;
		let bestPath: string | null = null;
		for (const rel of relPaths) {
			for (const pat of fileScopes) {
				if (!matcher(pat, rel)) continue;
				const spec = patternSpecificity(pat);
				if (spec > bestSpec) {
					bestSpec = spec;
					bestPath = rel;
				}
			}
		}
		if (bestPath === null) continue;

		ranked.push({
			id: c.id,
			title: c.title,
			type: c.type,
			path: bestPath,
			_spec: bestSpec,
			_getCount: c.getCount,
			_updatedAt: c.updatedAt,
		});
	}

	ranked.sort((a, b) => {
		if (b._spec !== a._spec) return b._spec - a._spec;
		if (b._getCount !== a._getCount) return b._getCount - a._getCount;
		if (a._updatedAt !== b._updatedAt)
			return a._updatedAt < b._updatedAt ? 1 : -1; // newer first
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	return ranked
		.slice(0, CAP)
		.map(({ _spec, _getCount, _updatedAt, ...p }) => p);
}
