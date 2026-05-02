// src/lib/memory/extract.ts
import fs from "node:fs/promises";
import { extractorRunPath, extractorRunsDir } from "./paths.js";
import {
	openLifecycle,
	createMemory,
	addEvidence,
	bumpConfidence,
	bumpReExtract,
} from "./lifecycle.js";
import type { LifecycleHandle } from "./lifecycle.js";
import { getProvider } from "../embed-provider.js";
import { readMemoryVector } from "./embed.js";
import type { EvidenceLayer, SessionRecord } from "../history/types.js";
import { listSessions, readSession } from "../history/store.js";
import { isHarnessInjection } from "../history/compact.js";

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
	minConfidence?: number; // default: 0.4
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
	const minConfidence = opts.minConfidence ?? 0.4;
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
		const decisions = produceDecisionCandidates(sessionId, newEvidence);
		const gotchas = produceGotchaCandidates(sessionId, newEvidence);
		const howtos = produceHowToCandidates(sessionId, newEvidence);
		const patterns = await producePatternCandidates(
			repoKey,
			sessionId,
			session,
		);
		const all = [...decisions, ...gotchas, ...howtos, ...patterns];

		for (const cand of all) {
			// Structural floor: when no boost fired (confidence still at BASE),
			// require a non-trivial body. Catches throwaway prompts like "okay good"
			// that match IMPERATIVE_RE / SYMPTOM_RE on a single stopword. Only
			// applies at exactly BASE_CONFIDENCE so any boost (correction prefix,
			// ack, workaround) lets short-but-strong feedback through.
			if (
				cand.confidence === BASE_CONFIDENCE &&
				cand.body.trim().length < BASE_CONFIDENCE_MIN_BODY_CHARS
			) {
				manifest.rejectedCandidates.push({
					type: cand.type,
					reason: `base-confidence body too short (<${BASE_CONFIDENCE_MIN_BODY_CHARS} chars)`,
					previewText: cand.title,
				});
				continue;
			}
			if (cand.confidence < minConfidence) {
				manifest.rejectedCandidates.push({
					type: cand.type,
					reason: `below confidence floor ${minConfidence}`,
					previewText: cand.title,
				});
				continue;
			}

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
				for (const p of cand.provenance) {
					await addEvidence(lc, dedupHit, p);
				}
				await bumpConfidence(lc, dedupHit, 0.1, `re-extract from ${sessionId}`);
				bumpReExtract(lc, dedupHit);
				manifest.evidenceAppended += 1;
				manifest.appendedToMemoryIds.push(dedupHit);
				continue;
			}

			const id = await createMemory(lc, {
				type: cand.type,
				title: cand.title,
				body: cand.body,
				scope: { files: cand.scopeFiles, tags: cand.tags },
				source: "extracted",
				confidence: cand.confidence,
				typeFields: cand.typeFields,
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
// Confidence model — see specs/2026-04-30-memory-schema-design.md
// "Post-implementation finding (2026-05-01) — correction-prefix as boost".
// Decision/gotcha extractors iterate over all userPrompts; correction-prefix
// and assistant-ACK each contribute +0.10 above a 0.35 base. The default
// minConfidence: 0.4 floor (applied in extractFromSession) rejects bare
// matches that pick up neither boost.
// ---------------------------------------------------------------------------

const BASE_CONFIDENCE = 0.35;
const SIGNAL_BOOST = 0.1;
const BASE_CONFIDENCE_MIN_BODY_CHARS = 25;

// Mirror of CORRECTION_RE in src/lib/history/compact.ts. Kept local to the
// extractor so the boost is computed from the prompt text directly without a
// reverse lookup against evidence.corrections.
const CORRECTION_PREFIX_RE =
	/^\s*(no|stop|don't|dont|wait|actually|instead|but)\b/i;

// ---------------------------------------------------------------------------
// Gotcha heuristic
// ---------------------------------------------------------------------------

const SYMPTOM_RE =
	/\b(breaks?|broken|fails?|race|hangs?|wrong|bug|flaky|crash(es|ed)?|errors?)\b/i;
const WORKAROUND_RE =
	/\b(fix(:|es|ed)?|instead|workaround|use\s+\S+\s+instead|bypass|patch)\b/i;

export function produceGotchaCandidates(
	sessionId: string,
	evidence: EvidenceLayer,
): ProducedCandidate[] {
	const out: ProducedCandidate[] = [];
	for (const u of evidence.userPrompts) {
		if (!SYMPTOM_RE.test(u.text)) continue;
		const workaround =
			u.nextAssistantSnippet !== undefined &&
			WORKAROUND_RE.test(u.nextAssistantSnippet);
		const correction = CORRECTION_PREFIX_RE.test(u.text);
		const confidence =
			BASE_CONFIDENCE +
			(workaround ? SIGNAL_BOOST : 0) +
			(correction ? SIGNAL_BOOST : 0);
		const title = u.text.length <= 80 ? u.text : u.text.slice(0, 77) + "…";
		const body = u.nextAssistantSnippet
			? `**Symptom:** ${u.text}\n\n**Workaround:** ${u.nextAssistantSnippet}`
			: `**Symptom:** ${u.text}`;
		const file = nearestFile(evidence, u.turn);
		out.push({
			type: "gotcha",
			title,
			body,
			scopeFiles: file ? [file] : [],
			tags: extractTags(u.text),
			confidence,
			provenance: [
				{
					sessionId,
					turn: u.turn,
					kind: correction ? "user_correction" : "user_prompt",
					excerpt: u.text.slice(0, 280),
				},
			],
			typeFields: { severity: "warning" },
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Decision heuristic
// ---------------------------------------------------------------------------

const IMPERATIVE_RE = /\b(must|always|never|should|don't|dont|prefer|avoid)\b/i;
const ACK_RE =
	/\b(got it|understood|will do|noted|sure thing|okay,? i('| wi)ll)\b/i;

export function produceDecisionCandidates(
	sessionId: string,
	evidence: EvidenceLayer,
): ProducedCandidate[] {
	const out: ProducedCandidate[] = [];
	for (const u of evidence.userPrompts) {
		if (!IMPERATIVE_RE.test(u.text)) continue;
		const ack =
			u.nextAssistantSnippet !== undefined &&
			ACK_RE.test(u.nextAssistantSnippet);
		const correction = CORRECTION_PREFIX_RE.test(u.text);
		const confidence =
			BASE_CONFIDENCE +
			(ack ? SIGNAL_BOOST : 0) +
			(correction ? SIGNAL_BOOST : 0);
		const title = u.text.length <= 80 ? u.text : u.text.slice(0, 77) + "…";
		const body = u.nextAssistantSnippet
			? `${u.text}\n\n_Acknowledged:_ ${u.nextAssistantSnippet}`
			: u.text;
		out.push({
			type: "decision",
			title,
			body,
			scopeFiles: filesNearTurn(evidence, u.turn, 3),
			tags: extractTags(u.text),
			confidence,
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

// ---------------------------------------------------------------------------
// Pattern heuristic (cross-session co-occurrence)
// ---------------------------------------------------------------------------

const PATTERN_MIN_SESSIONS = 3;
const PATTERN_PROMPT_COSINE = 0.7;

function fileSetKey(paths: string[]): string {
	return [...new Set(paths)].sort().join("|");
}

export async function producePatternCandidates(
	repoKey: string,
	thisSessionId: string,
	thisSession: SessionRecord,
): Promise<ProducedCandidate[]> {
	const targetFiles = new Set(
		thisSession.evidence.filePaths.map((f) => f.path),
	);
	if (targetFiles.size === 0) return [];
	const targetKey = fileSetKey([...targetFiles]);

	const allIds = await listSessions(repoKey);
	const matching: SessionRecord[] = [];
	for (const id of allIds) {
		if (id === thisSessionId) continue;
		const rec = await readSession(repoKey, id);
		if (!rec) continue;
		const files = new Set(rec.evidence.filePaths.map((f) => f.path));
		if (fileSetKey([...files]) === targetKey) matching.push(rec);
	}
	if (matching.length < PATTERN_MIN_SESSIONS - 1) return [];

	// Cosine on userPrompts: average prompt embedding per session, then mean cosine to target.
	const provider = await getProvider();
	const targetPrompts = thisSession.evidence.userPrompts
		.map((p) => p.text)
		.join(" ");
	if (targetPrompts.length === 0) return [];
	const [targetVec] = await provider.embed([targetPrompts]);

	let similarCount = 0;
	for (const rec of matching) {
		const prompts = rec.evidence.userPrompts.map((p) => p.text).join(" ");
		if (prompts.length === 0) continue;
		const [vec] = await provider.embed([prompts]);
		if (cosine(targetVec!, vec!) >= PATTERN_PROMPT_COSINE) similarCount++;
	}
	if (similarCount + 1 < PATTERN_MIN_SESSIONS) return [];

	const files = [...targetFiles];
	const summary =
		thisSession.summary.length > 0 ? thisSession.summary : targetPrompts;
	return [
		{
			type: "pattern",
			title: `Recurring work on ${files[0]}${files.length > 1 ? ` and ${files.length - 1} others` : ""}`,
			body: `**Where:** ${files.join(", ")}\n\n**Convention:** ${summary.slice(0, 400)}`,
			scopeFiles: files,
			tags: extractTags(targetPrompts),
			confidence: 0.35,
			provenance: [
				{
					sessionId: thisSessionId,
					turn: 0,
					kind: "summary",
					excerpt: summary.slice(0, 280),
				},
			],
		},
	];
}

// ---------------------------------------------------------------------------
// How-to heuristic
// ---------------------------------------------------------------------------

const HOW_TO_RE =
	/^\s*(how (do|to|can) i|steps|process|procedure|what are the steps)\b/i;
const NUMBERED_LIST_RE = /(^|\n)\s*1[.)]\s/;

const HOW_TO_MIN_TOOLS = 3;

export function produceHowToCandidates(
	sessionId: string,
	evidence: EvidenceLayer,
): ProducedCandidate[] {
	const out: ProducedCandidate[] = [];
	for (const p of evidence.userPrompts) {
		if (!HOW_TO_RE.test(p.text)) continue;
		const sequential = evidence.toolCalls.filter((tc) => tc.turn > p.turn);
		if (sequential.length < HOW_TO_MIN_TOOLS) continue;
		const closingList =
			p.nextAssistantSnippet !== undefined &&
			NUMBERED_LIST_RE.test(p.nextAssistantSnippet);
		const minTurn = sequential[0].turn;
		const maxTurn = sequential[sequential.length - 1].turn;
		const files = [
			...new Set(
				evidence.filePaths
					.filter((f) => f.turn >= minTurn && f.turn <= maxTurn)
					.map((f) => f.path),
			),
		];
		const stepsBody = closingList
			? p.nextAssistantSnippet!
			: sequential
					.map(
						(tc, i) => `${i + 1}. ${tc.name}${tc.args ? ` — ${tc.args}` : ""}`,
					)
					.join("\n");
		const title = p.text.length <= 80 ? p.text : p.text.slice(0, 77) + "…";
		out.push({
			type: "how-to",
			title,
			body: `**Goal:** ${p.text}\n\n**Steps:**\n${stepsBody}`,
			scopeFiles: files,
			tags: extractTags(p.text),
			confidence: closingList ? 0.5 : 0.4,
			provenance: [
				{
					sessionId,
					turn: p.turn,
					kind: "user_prompt",
					excerpt: p.text.slice(0, 280),
				},
			],
		});
	}
	return out;
}
