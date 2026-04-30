// src/lib/memory/extract.ts
import fs from "node:fs/promises";
import { extractorRunPath, extractorRunsDir } from "./paths.js";
import type { LifecycleHandle } from "./lifecycle.js";
import { getProvider } from "../embed-provider.js";
import { readMemoryVector } from "./embed.js";
import type { EvidenceLayer, SessionRecord } from "../history/types.js";
import { listSessions, readSession } from "../history/store.js";

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
	"always","never","must","should","before","after","when","then","also","just",
	"use","used","using","make","have","will","would","could","please","want",
	"need","like","your","mine","here","there","than","into","onto","over",
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

// ---------------------------------------------------------------------------
// Gotcha heuristic
// ---------------------------------------------------------------------------

const SYMPTOM_RE = /\b(breaks?|broken|fails?|race|hangs?|wrong|bug|flaky|crash(es|ed)?|errors?)\b/i;
const WORKAROUND_RE = /\b(fix(:|es|ed)?|instead|workaround|use\s+\S+\s+instead|bypass|patch)\b/i;

export function produceGotchaCandidates(
	sessionId: string,
	evidence: EvidenceLayer,
): ProducedCandidate[] {
	const out: ProducedCandidate[] = [];
	for (const c of evidence.corrections) {
		const symptom = SYMPTOM_RE.test(c.text);
		if (!symptom) continue;
		const workaround =
			c.nextAssistantSnippet !== undefined && WORKAROUND_RE.test(c.nextAssistantSnippet);
		const title = c.text.length <= 80 ? c.text : c.text.slice(0, 77) + "…";
		const body = c.nextAssistantSnippet
			? `**Symptom:** ${c.text}\n\n**Workaround:** ${c.nextAssistantSnippet}`
			: `**Symptom:** ${c.text}`;
		const file = nearestFile(evidence, c.turn);
		out.push({
			type: "gotcha",
			title,
			body,
			scopeFiles: file ? [file] : [],
			tags: extractTags(c.text),
			confidence: workaround ? 0.55 : 0.45,
			provenance: [{
				sessionId,
				turn: c.turn,
				kind: "user_correction",
				excerpt: c.text.slice(0, 280),
			}],
			typeFields: { severity: "warning" },
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Decision heuristic
// ---------------------------------------------------------------------------

const IMPERATIVE_RE = /\b(must|always|never|should|don't|dont|prefer|avoid)\b/i;
const ACK_RE = /\b(got it|understood|will do|noted|sure thing|okay,? i('| wi)ll)\b/i;

export function produceDecisionCandidates(
	sessionId: string,
	evidence: EvidenceLayer,
): ProducedCandidate[] {
	const out: ProducedCandidate[] = [];
	for (const c of evidence.corrections) {
		if (!IMPERATIVE_RE.test(c.text)) continue;
		const ack = c.nextAssistantSnippet !== undefined && ACK_RE.test(c.nextAssistantSnippet);
		const title = c.text.length <= 80 ? c.text : c.text.slice(0, 77) + "…";
		const body = c.nextAssistantSnippet
			? `${c.text}\n\n_Acknowledged:_ ${c.nextAssistantSnippet}`
			: c.text;
		out.push({
			type: "decision",
			title,
			body,
			scopeFiles: filesNearTurn(evidence, c.turn, 3),
			tags: extractTags(c.text),
			confidence: ack ? 0.55 : 0.45,
			provenance: [{
				sessionId,
				turn: c.turn,
				kind: "user_correction",
				excerpt: c.text.slice(0, 280),
			}],
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
	const targetFiles = new Set(thisSession.evidence.filePaths.map((f) => f.path));
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
	const targetPrompts = thisSession.evidence.userPrompts.map((p) => p.text).join(" ");
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
	const summary = thisSession.summary.length > 0 ? thisSession.summary : targetPrompts;
	return [{
		type: "pattern",
		title: `Recurring work on ${files[0]}${files.length > 1 ? ` and ${files.length - 1} others` : ""}`,
		body: `**Where:** ${files.join(", ")}\n\n**Convention:** ${summary.slice(0, 400)}`,
		scopeFiles: files,
		tags: extractTags(targetPrompts),
		confidence: 0.35,
		provenance: [{
			sessionId: thisSessionId,
			turn: 0,
			kind: "summary",
			excerpt: summary.slice(0, 280),
		}],
	}];
}

