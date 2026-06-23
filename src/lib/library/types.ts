// src/lib/library/types.ts

export type SourceKind = "repo" | "dir";

export interface SourceOrigin {
	repoKey?: string; // sha16(gitCommonDir) when kind === "repo"
	name: string; // display label
}

export interface SourceRecord {
	id: string; // hashId(realpath(rootPath))
	rootPath: string; // absolute, realpath-resolved
	kind: SourceKind;
	origin: SourceOrigin;
	includeGlobs: string[];
	excludeGlobs: string[];
	addedAt: string; // ISO
	lastIndexedAt: string | null; // ISO
	status: "ok" | "errored";
	statusReason?: string;
}

// A chunk emitted by the chunker, before the indexer attaches docId/contentHash.
export interface ChunkOut {
	ordinal: number;
	headingPath: string[];
	text: string;
	lineStart: number; // 1-based, inclusive
	lineEnd: number; // 1-based, inclusive
}

export interface Passage extends ChunkOut {
	docId: string;
	contentHash: string;
}

export interface ValueSignal {
	docType: string;
	statusHeader?: string;
	mtimeMs: number;
	pinned: boolean;
}

export interface LibraryHit {
	snippet: string;
	citation: {
		sourceId: string;
		filePath: string; // absolute path for the agent to open
		relPath: string;
		lineStart: number;
		lineEnd: number;
		headingPath: string[];
	};
	origin: SourceOrigin;
	value: ValueSignal;
	freshness: "fresh" | "stale";
	score: number;
}

export interface Annotation {
	docId: string;
	summary?: string;
	labels: string[];
	topics: string[];
	value?: Partial<ValueSignal>;
	relatedDocs: string[];
	provenance: { author: string; model?: string; timestamp: string };
}

// Model-aware index manifest. modelId/dim gate vector compatibility; files[]
// tracks per-file completion so a reindex resumes after interruption.
export interface Manifest {
	modelId: string;
	dim: number;
	files: Record<
		string,
		{ contentHash: string; mtimeMs: number; completed: boolean }
	>;
}

// Injected embedding seam. Production builds this via getLibraryEmbedder();
// tests pass a deterministic fake so CI never downloads a model.
export interface Embedder {
	modelId: string;
	dim: number;
	embed(texts: string[]): Promise<Float32Array[]>;
}
