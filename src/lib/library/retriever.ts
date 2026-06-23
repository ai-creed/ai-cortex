// src/lib/library/retriever.ts
import fs from "node:fs";
import path from "node:path";
import { readManifest } from "./manifest.js";
import { getSource, listSources } from "./source-registry.js";
import { LibraryIndexStore, type PassageRow } from "./store/index-store.js";
import type {
	Embedder,
	LibraryHit,
	SourceRecord,
	ValueSignal,
} from "./types.js";
import { valueWeight } from "./value.js";

export interface RetrieveCtx {
	currentRepoKey?: string;
	sourceFilter?: string[];
	topN?: number;
}

const RRF_K = 60; // standard Reciprocal Rank Fusion constant
const POOL = 50; // per-retriever candidate pool per source
const ORIGIN_BOOST = 0.1; // mirrors the cross-tier memory boost, on a [0,1] score

interface Candidate {
	key: string; // `${sourceId}:${passageId}`
	sourceId: string;
	passageId: number;
	rrf: number;
}

function fuseInto(
	map: Map<string, Candidate>,
	sourceId: string,
	rankedIds: number[],
): void {
	rankedIds.forEach((passageId, idx) => {
		const key = `${sourceId}:${passageId}`;
		const contrib = 1 / (RRF_K + idx);
		const existing = map.get(key);
		if (existing) existing.rrf += contrib;
		else map.set(key, { key, sourceId, passageId, rrf: contrib });
	});
}

export async function retrieve(
	query: string,
	embedder: Embedder | null,
	ctx: RetrieveCtx = {},
): Promise<LibraryHit[]> {
	const topN = ctx.topN ?? 8;
	const sources = (
		ctx.sourceFilter
			? ctx.sourceFilter
					.map((id) => getSource(id))
					.filter((s): s is SourceRecord => s !== null)
			: listSources()
	).filter((s) => s.status === "ok");
	if (sources.length === 0) return [];

	// Embed the query for the semantic half. If the model is unavailable or
	// inference fails, degrade to lexical-only (FTS still works) and warn.
	let queryVec: Float32Array | null = null;
	if (embedder) {
		try {
			const [v] = await embedder.embed([query]);
			queryVec = v ?? null;
		} catch (err) {
			process.stderr.write(
				`[library] embedding failed; falling back to lexical-only: ${err instanceof Error ? err.message : String(err)}\n`,
			);
			queryVec = null;
		}
	}

	const candidates = new Map<string, Candidate>();
	const rowsBySource = new Map<string, Map<number, PassageRow>>();
	const sourceById = new Map<string, SourceRecord>();

	for (const source of sources) {
		const manifest = readManifest(source.id);
		if (!manifest) continue; // not indexed yet
		const store = LibraryIndexStore.tryOpen(source.id, manifest.dim);
		if (!store) continue; // corrupt/locked index; skip this source, never crash the search
		sourceById.set(source.id, source);
		try {
			const lexical = store.searchFts(query, POOL).map((h) => h.passageId);
			// Semantic only when we have a query vector AND the index dim matches the
			// embedder dim; otherwise this source contributes lexical hits only.
			const useSemantic =
				queryVec !== null && embedder !== null && manifest.dim === embedder.dim;
			const semantic = useSemantic
				? store.semanticTopK(queryVec!, POOL).map((h) => h.passageId)
				: [];
			fuseInto(candidates, source.id, lexical);
			if (semantic.length > 0) fuseInto(candidates, source.id, semantic);
			const wanted = new Set<number>([...lexical, ...semantic]);
			const rows = store.loadPassages([...wanted]);
			const byId = new Map<number, PassageRow>();
			for (const r of rows) byId.set(r.passageId, r);
			rowsBySource.set(source.id, byId);
		} finally {
			store.close();
		}
	}

	const all = [...candidates.values()];
	if (all.length === 0) return [];

	// Min-max normalize fused RRF to [0,1] so the additive origin/value boosts
	// (each <= 0.10) keep the spec's intended magnitude.
	const rrfs = all.map((c) => c.rrf);
	const min = Math.min(...rrfs);
	const max = Math.max(...rrfs);
	const span = max - min || 1;

	const hits: LibraryHit[] = [];
	for (const c of all) {
		const source = sourceById.get(c.sourceId)!;
		const row = rowsBySource.get(c.sourceId)?.get(c.passageId);
		if (!row) continue;
		const value: ValueSignal = {
			docType: row.docType,
			statusHeader: row.statusHeader ?? undefined,
			mtimeMs: row.mtimeMs,
			pinned: row.pinned === 1,
		};
		const norm = (c.rrf - min) / span;
		const sameRepo =
			ctx.currentRepoKey !== undefined &&
			source.origin.repoKey === ctx.currentRepoKey;
		const score = norm + (sameRepo ? ORIGIN_BOOST : 0) + valueWeight(value);

		const absPath = path.join(source.rootPath, row.relPath);
		let freshness: "fresh" | "stale" = "fresh";
		try {
			const manifest = readManifest(source.id);
			const recorded = manifest?.files[row.relPath]?.mtimeMs ?? Infinity;
			if (fs.statSync(absPath).mtimeMs > recorded) freshness = "stale";
		} catch {
			freshness = "stale"; // file vanished since indexing
		}

		hits.push({
			snippet: row.text.length > 400 ? row.text.slice(0, 400) + "…" : row.text,
			citation: {
				sourceId: source.id,
				filePath: absPath,
				relPath: row.relPath,
				lineStart: row.lineStart,
				lineEnd: row.lineEnd,
				headingPath: row.headingPath,
			},
			origin: source.origin,
			value,
			freshness,
			score,
		});
	}

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, topN);
}
