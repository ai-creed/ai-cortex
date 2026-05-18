// src/lib/memory/extract.ts
import fs from "node:fs/promises";
import { extractorRunPath, extractorRunsDir } from "./paths.js";
import { openLifecycle, createMemory, addEvidence } from "./lifecycle.js";
import type { LifecycleHandle } from "./lifecycle.js";
import { getProvider } from "../embed-provider.js";
import { readMemoryVector } from "./embed.js";
import type { EvidenceLayer } from "../history/types.js";
import { readSession } from "../history/store.js";
import { isHarnessInjection } from "../history/compact.js";
import { structuralReject } from "./gate.js";

export const EXTRACTOR_MANIFEST_VERSION = 1;
export const DEFAULT_DEDUP_COSINE = 0.85;

export type ExtractCandidateType =
	| "capture"
	| "decision"
	| "gotcha"
	| "pattern"
	| "how-to";

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
	/**
	 * @deprecated No-op since the structural-gate rewrite. Extraction no longer
	 * applies a confidence floor — structural rejection happens in the gate and
	 * the only remaining drop reason is dedup. Retained for call-site
	 * compatibility; the value is ignored.
	 */
	minConfidence?: number;
	dedupCosine?: number; // default: 0.85
	allowReExtract?: boolean; // default: false (skip if manifest exists)
};

export type ExtractResult = ExtractorManifest;

// ---------------------------------------------------------------------------
// Internal helpers for extractFromSession
// ---------------------------------------------------------------------------

function calcMaxTurn(evidence: EvidenceLayer): number {
	let m = 0;
	for (const t of evidence.toolCalls) if (t.turn > m) m = t.turn;
	for (const f of evidence.filePaths) if (f.turn > m) m = f.turn;
	for (const u of evidence.userPrompts) if (u.turn > m) m = u.turn;
	for (const c of evidence.corrections) if (c.turn > m) m = c.turn;
	return m;
}

function filterEvidenceAfterTurn(
	evidence: EvidenceLayer,
	afterTurn: number,
): EvidenceLayer {
	// Defensively drop harness-injected pseudo-prompts that may be present in
	// sessions captured before the compactor learned to filter them. Tool calls
	// and file paths are unaffected.
	return {
		toolCalls: evidence.toolCalls.filter((t) => t.turn > afterTurn),
		filePaths: evidence.filePaths.filter((f) => f.turn > afterTurn),
		userPrompts: evidence.userPrompts.filter(
			(u) => u.turn > afterTurn && !isHarnessInjection(u.text),
		),
		corrections: evidence.corrections.filter(
			(c) => c.turn > afterTurn && !isHarnessInjection(c.text),
		),
	};
}

// Public entry — implemented in Part 5
export async function extractFromSession(
	repoKey: string,
	sessionId: string,
	opts: ExtractOptions = {},
): Promise<ExtractResult> {
	const allowReExtract = opts.allowReExtract ?? false;
	const dedupCosine = opts.dedupCosine ?? DEFAULT_DEDUP_COSINE;

	const session = await readSession(repoKey, sessionId);
	if (!session) {
		throw new Error(`extractFromSession: no session at id=${sessionId}`);
	}

	const prior = allowReExtract ? null : await readManifest(repoKey, sessionId);
	const afterTurn = prior?.lastProcessedTurn ?? 0;

	const newEvidence = filterEvidenceAfterTurn(session.evidence, afterTurn);
	const newMaxTurn = Math.max(afterTurn, calcMaxTurn(session.evidence));
	const hasNewWork =
		newEvidence.toolCalls.length +
			newEvidence.filePaths.length +
			newEvidence.userPrompts.length +
			newEvidence.corrections.length >
		0;
	if (!hasNewWork && prior) {
		return {
			...prior,
			runAt: new Date().toISOString(),
			candidatesCreated: 0,
			evidenceAppended: 0,
			rejectedCandidates: [],
			createdMemoryIds: [],
			appendedToMemoryIds: [],
		};
	}

	const lc = await openLifecycle(repoKey);
	const manifest: ExtractorManifest = {
		version: EXTRACTOR_MANIFEST_VERSION,
		sessionId,
		runAt: new Date().toISOString(),
		lastProcessedTurn: newMaxTurn,
		candidatesCreated: 0,
		evidenceAppended: 0,
		rejectedCandidates: [],
		createdMemoryIds: [],
		appendedToMemoryIds: [],
	};

	try {
		// One pass over userPrompts: every turn that survives the structural
		// gate becomes a `capture` candidate. The gate is reject-only — no
		// positive classification; the agent judges durability downstream.
		// Corrections are already represented within userPrompts in the
		// evidence layer, so we do NOT iterate corrections separately
		// (double-counting). The only remaining drop reason is dedup.
		const all = produceCaptureCandidates(sessionId, newEvidence);

		for (const cand of all) {
			const dedupHit = await findDedupTarget(
				lc,
				{
					type: cand.type,
					title: cand.title,
					body: cand.body,
					tags: cand.tags,
				},
				{ dedupCosine },
			);
			if (dedupHit) {
				// Extracted-promotion is disabled: append provenance only.
				// No bumpConfidence / bumpReExtract for extracted captures.
				for (const p of cand.provenance) {
					await addEvidence(lc, dedupHit, p);
				}
				manifest.evidenceAppended += 1;
				manifest.appendedToMemoryIds.push(dedupHit);
				continue;
			}

			const id = await createMemory(lc, {
				type: "capture",
				title: cand.title,
				body: cand.body,
				scope: { files: cand.scopeFiles, tags: cand.tags },
				source: "extracted",
				confidence: cand.confidence,
			});
			for (const p of cand.provenance) {
				await addEvidence(lc, id, p);
			}
			manifest.candidatesCreated += 1;
			manifest.createdMemoryIds.push(id);
		}
	} finally {
		lc.close();
	}

	await writeManifest(repoKey, sessionId, manifest);
	return manifest;
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
	let dot = 0,
		na = 0,
		nb = 0;
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
	const [candVec] = await provider.embed([
		`${candidate.title}\n\n${candidate.body}`,
	]);

	// Pull all existing memories of the same type that are active|candidate.
	const rows = lc.index
		.rawDb()
		.prepare(
			"SELECT id FROM memories WHERE type = ? AND status IN ('active','candidate')",
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
	provenance: {
		sessionId: string;
		turn: number;
		kind: "user_correction" | "user_prompt" | "tool_call" | "summary";
		excerpt?: string;
	}[];
	typeFields?: Record<string, unknown>;
};

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"in",
	"on",
	"at",
	"to",
	"of",
	"for",
	"with",
	"by",
	"from",
	"as",
	"this",
	"that",
	"these",
	"those",
	"i",
	"you",
	"we",
	"they",
	"it",
	"he",
	"she",
	"do",
	"does",
	"did",
	"not",
	"no",
	"yes",
	"so",
	"always",
	"never",
	"must",
	"should",
	"before",
	"after",
	"when",
	"then",
	"also",
	"just",
	"use",
	"used",
	"using",
	"make",
	"have",
	"will",
	"would",
	"could",
	"please",
	"want",
	"need",
	"like",
	"your",
	"mine",
	"here",
	"there",
	"than",
	"into",
	"onto",
	"over",
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

export function nearestFile(
	evidence: EvidenceLayer,
	turn: number,
): string | null {
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

// ---------------------------------------------------------------------------
// Capture producer
//
// Reject-only structural gate, no positive classification. Every user turn in
// `evidence.userPrompts` is a candidate-turn; survivors of `structuralReject`
// become a single `capture` candidate. Corrections are already represented
// within `userPrompts` in the evidence layer, so we iterate `userPrompts`
// exactly once (iterating corrections too would double-count). The agent
// judges durability downstream — confidence is a fixed placeholder and is no
// longer used for gating.
// ---------------------------------------------------------------------------

const BASE_CONFIDENCE = 0.35;

// Mirror of CORRECTION_RE in src/lib/history/compact.ts. Kept local so the
// provenance kind is computed from the prompt text directly without a reverse
// lookup against evidence.corrections.
const CORRECTION_PREFIX_RE =
	/^\s*(no|stop|don't|dont|wait|actually|instead|but)\b/i;

export function produceCaptureCandidates(
	sessionId: string,
	evidence: EvidenceLayer,
): ProducedCandidate[] {
	const out: ProducedCandidate[] = [];
	for (const u of evidence.userPrompts) {
		if (structuralReject(u.text) !== null) continue;
		const correction = CORRECTION_PREFIX_RE.test(u.text);
		const title = u.text.length <= 80 ? u.text : u.text.slice(0, 77) + "…";
		const body = u.nextAssistantSnippet
			? `${u.text}\n\n_Acknowledged:_ ${u.nextAssistantSnippet}`
			: u.text;
		out.push({
			type: "capture",
			title,
			body,
			scopeFiles: filesNearTurn(evidence, u.turn, 3),
			tags: extractTags(u.text),
			confidence: BASE_CONFIDENCE,
			provenance: [
				{
					sessionId,
					turn: u.turn,
					kind: correction ? "user_correction" : "user_prompt",
					excerpt: u.text.slice(0, 280),
				},
			],
		});
	}
	return out;
}
