// src/lib/library/index.ts
// PUBLIC API. The rest of the app imports ONLY from this file.
import fs from "node:fs";
import path from "node:path";
import { getLibraryEmbedder } from "./embed.js";
import { indexSource } from "./indexer.js";
import { readManifest } from "./manifest.js";
import { historyO6Source, type O6SessionSource } from "./o6.js";
import { retrieve, type RetrieveCtx } from "./retriever.js";
import { getSource, listSources, registerSource, updateSource } from "./source-registry.js";
import { recordSearch } from "./telemetry.js";
import type { Embedder, LibraryHit, SourceRecord } from "./types.js";

export type {
	SourceRecord,
	LibraryHit,
	Annotation,
	ValueSignal,
	Embedder,
} from "./types.js";
export type { RetrieveCtx } from "./retriever.js";
export type { O6SessionSource, SessionMarker } from "./o6.js";
export {
	registerSource,
	listSources,
	getSource,
	removeSource,
} from "./source-registry.js";
export { computeO6Metrics } from "./telemetry.js";
export type { SearchEvent, O6Metrics } from "./telemetry.js";
export {
	LibrarySearchInput,
	LibraryRegisterInput,
	LibraryReindexInput,
	LibrarySearchResultSchema,
} from "./mcp-schemas.js";

export interface SourceStatus extends SourceRecord {
	docCount: number;
	staleCount: number | null; // null when the optional staleness stat pass was not requested
}

// Sources with status detail for library_list_sources (spec: status plus
// lastIndexed, docCount, staleness). docCount comes from the manifest (cheap);
// staleCount is an opt-in stat pass over the indexed files.
export function listSourceStatuses(
	opts: { staleness?: boolean } = {},
): SourceStatus[] {
	return listSources().map((source) => {
		const manifest = readManifest(source.id);
		const files = manifest ? Object.keys(manifest.files) : [];
		let staleCount: number | null = null;
		if (opts.staleness && manifest) {
			staleCount = 0;
			for (const rel of files) {
				try {
					if (
						fs.statSync(path.join(source.rootPath, rel)).mtimeMs >
						manifest.files[rel]!.mtimeMs
					) {
						staleCount++;
					}
				} catch {
					staleCount++; // a vanished indexed file counts as stale
				}
			}
		}
		return { ...source, docCount: files.length, staleCount };
	});
}

export interface ReindexReport {
	sourceId: string;
	name: string;
	status: "ok" | "errored";
	docsIndexed: number;
	docsDeleted: number;
	passages: number;
	reason?: string;
}

export async function reindexLibrary(opts: {
	sourceId?: string;
	embedder?: Embedder;
	nowIso: string;
}): Promise<ReindexReport[]> {
	const embedder = opts.embedder ?? (await getLibraryEmbedder());
	const targets: SourceRecord[] = opts.sourceId
		? [getSource(opts.sourceId)].filter((s): s is SourceRecord => s !== null)
		: listSources();
	const reports: ReindexReport[] = [];
	for (const source of targets) {
		try {
			const r = await indexSource(source, embedder);
			updateSource(source.id, {
				lastIndexedAt: opts.nowIso,
				status: "ok",
				statusReason: undefined,
			});
			reports.push({
				sourceId: source.id,
				name: source.origin.name,
				status: "ok",
				docsIndexed: r.docsIndexed,
				docsDeleted: r.docsDeleted,
				passages: r.passages,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			updateSource(source.id, { status: "errored", statusReason: reason });
			reports.push({
				sourceId: source.id,
				name: source.origin.name,
				status: "errored",
				docsIndexed: 0,
				docsDeleted: 0,
				passages: 0,
				reason,
			});
		}
	}
	return reports;
}

import { computeO6Metrics as computeMetrics } from "./telemetry.js";

function flagVal(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
}

export async function runLibraryCli(
	args: string[],
	deps: { write?: (s: string) => void; embedder?: Embedder; nowIso?: string } = {},
): Promise<number> {
	const write = deps.write ?? ((s: string) => void process.stdout.write(s));
	const nowIso = deps.nowIso ?? new Date().toISOString();
	const sub = args[0];
	const rest = args.slice(1);

	switch (sub) {
		case "register": {
			const rootPath = rest.find((a) => !a.startsWith("--")) ?? process.cwd();
			const { source, warnings } = registerSource({ rootPath, label: flagVal(rest, "--label"), nowIso });
			for (const w of warnings) write(`warning: ${w}\n`);
			write(`registered ${source.origin.name} (${source.kind}) as ${source.id}\n`);
			return 0;
		}
		case "list": {
			const sources = listSourceStatuses({ staleness: true });
			if (sources.length === 0) {
				write("no sources registered\n");
				return 0;
			}
			for (const s of sources) {
				write(
					`${s.id}  ${s.origin.name}  [${s.kind}]  ${s.status}  lastIndexed=${s.lastIndexedAt ?? "never"}  docs=${s.docCount}  stale=${s.staleCount ?? "n/a"}\n`,
				);
			}
			return 0;
		}
		case "reindex": {
			const reports = await reindexLibrary({ sourceId: flagVal(rest, "--source"), embedder: deps.embedder, nowIso });
			for (const r of reports) {
				write(`${r.name}: ${r.status} indexed=${r.docsIndexed} deleted=${r.docsDeleted} passages=${r.passages}${r.reason ? " reason=" + r.reason : ""}\n`);
			}
			if (reports.length === 0) write("no sources to reindex\n");
			return 0;
		}
		case "search": {
			const query = rest.filter((a) => !a.startsWith("--")).join(" ");
			if (!query) {
				write("usage: cortex library search <query> [--repo-key <key>] [--top <n>]\n");
				return 1;
			}
			const top = flagVal(rest, "--top");
			const hits = await searchLibrary(query, {
				ctx: { currentRepoKey: flagVal(rest, "--repo-key"), topN: top ? Number(top) : undefined },
				embedder: deps.embedder,
				nowIso,
			});
			if (hits.length === 0) {
				write("no results\n");
				return 0;
			}
			for (const h of hits) {
				write(`${h.citation.relPath}:${h.citation.lineStart} (${h.origin.name})${h.freshness === "stale" ? " [stale]" : ""}  ${h.snippet.slice(0, 160)}\n`);
			}
			return 0;
		}
		case "metrics": {
			// Downstream-touch correlates recorded searches with session-history file
			// evidence (per session + repoKey), gathered independently of any consult.
			const m = await computeMetrics({
				sessionFilePaths: (sid, rk) => historyO6Source.filePaths(sid, rk),
			});
			write(
				`searches=${m.searches} nonempty=${m.returnedNonemptyRate.toFixed(2)} downstreamTouch=${m.downstreamTouchRate.toFixed(2)} inRepoHitRatio=${m.inRepoHitRatio.toFixed(2)}\n`,
			);
			return 0;
		}
		default:
			write("usage: cortex library <register|list|reindex|search|metrics>\n");
			return 1;
	}
}

export async function searchLibrary(
	query: string,
	opts: {
		ctx?: RetrieveCtx;
		embedder?: Embedder;
		nowIso: string;
		cwd?: string; // for session detection (defaults to process.cwd())
		sessionId?: string; // explicit override (tests); otherwise resolved via o6
		turn?: number; // explicit override (tests)
		o6?: O6SessionSource; // injectable; defaults to historyO6Source
	},
): Promise<LibraryHit[]> {
	// Build the embedder for the semantic half. If it cannot load, search still
	// runs lexical-only (the retriever handles a null embedder) and we warn.
	let embedder: Embedder | null = opts.embedder ?? null;
	if (!embedder) {
		try {
			embedder = await getLibraryEmbedder();
		} catch (err) {
			process.stderr.write(
				`[library] embedder unavailable; lexical-only search: ${err instanceof Error ? err.message : String(err)}\n`,
			);
			embedder = null;
		}
	}
	const hits = await retrieve(query, embedder, opts.ctx);
	const sourcesQueried =
		opts.ctx?.sourceFilter?.length ??
		listSources().filter((s) => s.status === "ok").length;

	// Stamp the search with the current session marker so downstream-touch can
	// correlate later same-session file activity. Explicit sessionId/turn (tests)
	// win; otherwise resolve via the injectable O6 source (default: session-history).
	let sessionId = opts.sessionId;
	let turn = opts.turn;
	if (sessionId === undefined) {
		const marker = await (opts.o6 ?? historyO6Source).current(
			opts.ctx?.currentRepoKey,
			opts.cwd ?? process.cwd(),
		);
		if (marker) {
			sessionId = marker.sessionId;
			turn = marker.turn;
		}
	}

	try {
		recordSearch({
			ts: opts.nowIso,
			sessionId,
			turn,
			query,
			sourcesQueried,
			currentRepoKey: opts.ctx?.currentRepoKey,
			hits: hits.map((h) => ({
				sourceId: h.citation.sourceId,
				relPath: h.citation.relPath,
				absPath: h.citation.filePath,
				repoKey: h.origin.repoKey,
			})),
		});
	} catch {
		// Telemetry must never block or fail a search.
	}
	return hits;
}
