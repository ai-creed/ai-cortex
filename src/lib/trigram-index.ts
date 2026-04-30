// src/lib/trigram-index.ts
//
// On-demand per-token trigram index for fuzzy identifier matching. Built per
// query in the deep ranker (not persisted).
//
// Design note: matching is per-TOKEN, not per-concatenated-blob. Each item
// carries a list of identifier tokens (already split by the shared tokenizer —
// splitCamel + stopword filter). The query token is compared against every one
// of the item's tokens; the item's final similarity is the MAX over all its
// tokens. This makes "editor" match a file whose tokens include "editor"
// (from e.g. CardTitleEditor) at similarity 1.0, instead of collapsing toward
// 0 because the file also contains many unrelated tokens.

export type TrigramIndex = {
	// id -> list of per-token trigram sets, one entry per token in that item,
	// carrying both the trigram set and the original lowercased token so we can
	// report which file-side token produced the match.
	tokensByItem: Map<string, { token: string; tri: Set<string> }[]>;
};

export type TrigramHit = {
	sim: number;
	matchedToken: string;
};

export function trigrams(value: string): Set<string> {
	const out = new Set<string>();
	const lower = value.toLowerCase();
	for (let i = 0; i + 3 <= lower.length; i += 1) {
		out.add(lower.slice(i, i + 3));
	}
	return out;
}

/**
 * Jaccard similarity on trigram sets for two raw strings. Kept exported for
 * unit tests and ad-hoc callers; internal code paths use pre-computed sets.
 */
export function trigramSim(a: string, b: string): number {
	const ta = trigrams(a);
	const tb = trigrams(b);
	return jaccardOnSets(ta, tb);
}

function jaccardOnSets(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared += 1;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}

export function buildTrigramIndex(
	items: { id: string; tokens: string[] }[],
): TrigramIndex {
	const tokensByItem = new Map<string, { token: string; tri: Set<string> }[]>();
	for (const { id, tokens } of items) {
		const perToken: { token: string; tri: Set<string> }[] = [];
		const seen = new Set<string>();
		for (const raw of tokens) {
			const tok = raw.toLowerCase();
			if (seen.has(tok)) continue;
			seen.add(tok);
			const tri = trigrams(tok);
			if (tri.size > 0) perToken.push({ token: tok, tri });
		}
		tokensByItem.set(id, perToken);
	}
	return { tokensByItem };
}

/**
 * For a single query token, returns `id -> { sim, matchedToken }` where `sim`
 * is the max Jaccard(queryTri, tokenTri) across the item's tokens and
 * `matchedToken` is the file-side token that produced that max, provided `sim`
 * meets the `minOverlap` threshold.
 *
 * Default threshold 0.4 catches close morphology (card/carding, editor/editing)
 * while rejecting coincidental 1-trigram overlaps.
 */
export function trigramQuery(
	idx: TrigramIndex,
	query: string,
	minOverlap = 0.4,
): Map<string, TrigramHit> {
	const qTri = trigrams(query);
	const out = new Map<string, TrigramHit>();
	if (qTri.size === 0) return out;
	for (const [id, perToken] of idx.tokensByItem) {
		let bestSim = 0;
		let bestToken = "";
		for (const { token, tri } of perToken) {
			const sim = jaccardOnSets(qTri, tri);
			if (sim > bestSim) {
				bestSim = sim;
				bestToken = token;
				if (bestSim === 1) break; // can't beat a perfect match
			}
		}
		if (bestSim >= minOverlap)
			out.set(id, { sim: bestSim, matchedToken: bestToken });
	}
	return out;
}
