import { readSession, readChunkVectors, getChunkText } from "./store.js";

export type HitKind = "summary" | "userPrompt" | "correction" | "toolCall" | "filePath" | "rawChunk";

export type Hit = {
	sessionId: string;
	kind: HitKind;
	turn: number | null;
	score: number;
	text: string;
};

export type SearchSessionInput = {
	repoKey: string;
	sessionId: string;
	query: string;
	limit?: number;
};

export type EmbedQueryFn = (q: string) => Promise<{ vector: Float32Array; modelName: string }>;

export type SearchSessionInputExtended = SearchSessionInput & {
	embedQuery?: EmbedQueryFn;
};

const WEIGHTS: Record<HitKind, number> = {
	correction: 1.0,
	userPrompt: 0.7,
	filePath: 0.7,
	toolCall: 0.5,
	summary: 0.6,
	rawChunk: 0.5,
};

export async function searchSession(input: SearchSessionInputExtended): Promise<Hit[]> {
	const rec = readSession(input.repoKey, input.sessionId);
	if (!rec) return [];

	const q = input.query.toLowerCase();
	const hits: Hit[] = [];

	if (rec.summary && rec.summary.toLowerCase().includes(q)) {
		hits.push({ sessionId: rec.id, kind: "summary", turn: null, score: WEIGHTS.summary, text: rec.summary });
	}
	for (const u of rec.evidence.userPrompts) {
		if (u.text.toLowerCase().includes(q)) {
			hits.push({ sessionId: rec.id, kind: "userPrompt", turn: u.turn, score: WEIGHTS.userPrompt, text: u.text });
		}
	}
	for (const c of rec.evidence.corrections) {
		if (c.text.toLowerCase().includes(q)) {
			hits.push({ sessionId: rec.id, kind: "correction", turn: c.turn, score: WEIGHTS.correction, text: c.text });
		}
	}
	for (const f of rec.evidence.filePaths) {
		if (f.path.toLowerCase().includes(q)) {
			hits.push({ sessionId: rec.id, kind: "filePath", turn: f.turn, score: WEIGHTS.filePath, text: f.path });
		}
	}
	for (const t of rec.evidence.toolCalls) {
		const haystack = `${t.name} ${t.args}`.toLowerCase();
		if (haystack.includes(q)) {
			hits.push({ sessionId: rec.id, kind: "toolCall", turn: t.turn, score: WEIGHTS.toolCall, text: `${t.name}: ${t.args}` });
		}
	}

	if (input.embedQuery && rec.hasRaw) {
		const { vector: qv, modelName } = await input.embedQuery(input.query);
		const vecs = readChunkVectors(input.repoKey, input.sessionId, modelName);
		if (vecs) {
			for (const [chunkId, cv] of vecs.byChunkId) {
				const score = cosine(qv, cv);
				if (score > 0.3) {
					const text = getChunkText(input.repoKey, input.sessionId, chunkId) ?? "";
					hits.push({
						sessionId: rec.id,
						kind: "rawChunk",
						turn: null,
						score: WEIGHTS.rawChunk * score,
						text,
					});
				}
			}
		}
	}

	hits.sort((a, b) => b.score - a.score);
	return input.limit ? hits.slice(0, input.limit) : hits;
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}
