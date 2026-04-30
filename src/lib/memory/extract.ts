// src/lib/memory/extract.ts
import fs from "node:fs/promises";
import { extractorRunPath, extractorRunsDir } from "./paths.js";
import { openLifecycle, createMemory, addEvidence } from "./lifecycle.js";
import type { LifecycleHandle } from "./lifecycle.js";
import { readSession } from "../history/store.js";
import type {
	SessionRecord,
	EvidenceLayer,
	UserPromptEvidence,
	CorrectionEvidence,
} from "../history/types.js";
import { getProvider } from "../embed-provider.js";
import { readMemoryVector } from "./embed.js";

export const EXTRACTOR_MANIFEST_VERSION = 1;
export const DEFAULT_DEDUP_COSINE = 0.85;

export type ExtractCandidateType = "decision" | "gotcha" | "pattern" | "how-to";

export type RejectedCandidate = {
	type: ExtractCandidateType;
	reason: string;
	previewText: string;
};

export type ExtractorManifest = {
	version: typeof EXTRACTOR_MANIFEST_VERSION;
	sessionId: string;
	runAt: string;
	// Highest turn number whose evidence has been considered by the extractor.
	// Subsequent runs filter to evidence with `turn > lastProcessedTurn` only
	// (unless allowReExtract is true). Initial run on a fresh session uses 0.
	lastProcessedTurn: number;
	candidatesCreated: number;
	evidenceAppended: number;
	rejectedCandidates: RejectedCandidate[];
	createdMemoryIds: string[];
	appendedToMemoryIds: string[];
};

export type ExtractOptions = {
	minConfidence?: number;       // default: 0.4
	dedupCosine?: number;         // default: 0.85
	allowReExtract?: boolean;     // default: false (skip if manifest exists)
};

export type ExtractResult = ExtractorManifest;

// Public entry — implemented in Part 5
export async function extractFromSession(
	_repoKey: string,
	_sessionId: string,
	_opts: ExtractOptions = {},
): Promise<ExtractResult> {
	throw new Error("not implemented");
}

export async function writeManifest(
	repoKey: string,
	sessionId: string,
	manifest: ExtractorManifest,
): Promise<void> {
	await fs.mkdir(extractorRunsDir(repoKey), { recursive: true });
	const finalPath = extractorRunPath(repoKey, sessionId);
	const tmp = finalPath + ".tmp";
	await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n");
	await fs.rename(tmp, finalPath);
}

export async function readManifest(
	repoKey: string,
	sessionId: string,
): Promise<ExtractorManifest | null> {
	const p = extractorRunPath(repoKey, sessionId);
	try {
		await fs.access(p);
	} catch {
		return null;
	}
	return JSON.parse(await fs.readFile(p, "utf8")) as ExtractorManifest;
}

export type DedupCandidate = {
	type: ExtractCandidateType;
	title: string;
	body: string;
	tags: string[];
};

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

export async function findDedupTarget(
	lc: LifecycleHandle,
	candidate: DedupCandidate,
	opts: { dedupCosine?: number } = {},
): Promise<string | null> {
	const threshold = opts.dedupCosine ?? DEFAULT_DEDUP_COSINE;
	const provider = await getProvider();
	const [candVec] = await provider.embed([`${candidate.title}\n\n${candidate.body}`]);

	// Pull all existing memories of the same type that are active|candidate.
	const rows = lc.index
		.rawDb()
		.prepare(
			`SELECT id FROM memories WHERE type = ? AND status IN ('active','candidate')`,
		)
		.all(candidate.type) as { id: string }[];

	let bestId: string | null = null;
	let bestCos = -1;
	for (const r of rows) {
		const scope = lc.index.scopeRows(r.id);
		const tags = scope.filter((s) => s.kind === "tag").map((s) => s.value);
		// Spec: require non-empty tag intersection unconditionally.
		// Untagged candidates have empty intersection → always create fresh.
		if (!candidate.tags.some((t) => tags.includes(t))) continue;
		const v = await readMemoryVector(lc.repoKey, r.id);
		if (!v) continue;
		const c = cosine(candVec!, v.vector);
		if (c > bestCos) {
			bestCos = c;
			bestId = r.id;
		}
	}
	if (bestId !== null && bestCos >= threshold) return bestId;
	return null;
}

// Suppress unused import warnings — these are imported for Part 5 callers.
void (openLifecycle as unknown);
void (createMemory as unknown);
void (addEvidence as unknown);
void (readSession as unknown);
void (0 as unknown as SessionRecord);
void (0 as unknown as EvidenceLayer);
void (0 as unknown as UserPromptEvidence);
void (0 as unknown as CorrectionEvidence);
