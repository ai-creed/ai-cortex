// src/lib/memory/extract.ts
import fs from "node:fs/promises";
import { extractorRunPath, extractorRunsDir } from "./paths.js";
import type { LifecycleHandle } from "./lifecycle.js";
import { getProvider } from "../embed-provider.js";
import { readMemoryVector } from "./embed.js";
import type { EvidenceLayer } from "../history/types.js";

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
		return JSON.parse(await fs.readFile(p, "utf8")) as ExtractorManifest;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
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

// ---------------------------------------------------------------------------
// Shared producer types and helpers
// ---------------------------------------------------------------------------

export type ProducedCandidate = {
	type: ExtractCandidateType;
	title: string;
	body: string;
	scopeFiles: string[];
	tags: string[];
	confidence: number;
	provenance: { sessionId: string; turn: number; kind: "user_correction" | "user_prompt" | "tool_call" | "summary"; excerpt?: string }[];
	typeFields?: Record<string, unknown>;
};

const STOPWORDS = new Set([
	"the","a","an","and","or","but","is","are","was","were","be","been","being",
	"in","on","at","to","of","for","with","by","from","as","this","that","these","those",
	"i","you","we","they","it","he","she","do","does","did","not","no","yes","so",
]);

export function extractTags(text: string, max = 5): string[] {
	const counts = new Map<string, number>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
		if (raw.length < 4 || STOPWORDS.has(raw)) continue;
		counts.set(raw, (counts.get(raw) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, max)
		.map(([w]) => w);
}

export function filesNearTurn(
	evidence: EvidenceLayer,
	turn: number,
	radius = 3,
): string[] {
	const out = new Set<string>();
	for (const f of evidence.filePaths) {
		if (Math.abs(f.turn - turn) <= radius) out.add(f.path);
	}
	return [...out];
}

export function nearestFile(evidence: EvidenceLayer, turn: number): string | null {
	let best: string | null = null;
	let bestDist = Infinity;
	for (const f of evidence.filePaths) {
		const d = Math.abs(f.turn - turn);
		if (d < bestDist) {
			best = f.path;
			bestDist = d;
		}
	}
	return best;
}

