import fs from "node:fs";
import Database from "better-sqlite3";
import { indexDbPath } from "./paths.js";
import { signalScore, captureTier, type CaptureTierValue } from "./gate.js";
import { readMemoryFile } from "./store.js";
import { readSession } from "../history/store.js";
import { parseTranscript } from "../history/compact.js";

export type CaptureContext =
	| { kind: "transcript"; turns: { role: string; text: string }[] }
	| { kind: "evidence"; userTurn: string; assistantSnippet: string | null }
	| { kind: "body-only" };

export type PendingCapture = {
	id: string;
	title: string;
	body: string;
	signalScore: number;
	tier: CaptureTierValue;
	source: { sessionId: string | null; turn: number | null };
	context: CaptureContext;
};

type EligibleRow = { id: string; title: string; updated_at: string };

export async function reviewPendingCaptures(
	repoKey: string,
	opts: { limit?: number; since?: string; includeLowSignal?: boolean } = {},
): Promise<PendingCapture[]> {
	const limit = opts.limit ?? 15;
	const dbp = indexDbPath(repoKey);
	if (!fs.existsSync(dbp)) return [];
	const db = new Database(dbp, { readonly: true });
	let rows: EligibleRow[];
	try {
		// NO SQL LIMIT: signalScore-desc ordering requires scoring the FULL
		// eligible set before slicing — a recency pre-limit would drop older
		// high-signal rows behind newer low-signal ones. The eligible
		// population is small by construction (the structural gate kills ~88%
		// and legacy triage deprecates the rest of the noise), so reading
		// every body is bounded and cheap.
		rows = db
			.prepare(
				`SELECT id, title, updated_at FROM memories
				 WHERE source='extracted' AND status='candidate'
				   AND type='capture'
				 ${opts.since ? "AND updated_at > @since" : ""}`,
			)
			.all({ since: opts.since ?? null }) as EligibleRow[];
	} finally {
		db.close();
	}
	const out: (PendingCapture & { _updatedAt: string })[] = [];
	for (const r of rows) {
		let rec;
		try {
			rec = await readMemoryFile(repoKey, r.id, "memories");
		} catch {
			continue; // index/file drift — skip silently
		}
		const prov = rec.frontmatter.provenance?.[0];
		const sessionId = prov?.sessionId ?? null;
		const turn = prov?.turn ?? null;
		out.push({
			id: r.id,
			title: r.title,
			body: rec.body,
			signalScore: signalScore(rec.body),
			tier: captureTier(rec.body),
			source: { sessionId, turn },
			context: await resolveContext(repoKey, sessionId, turn, rec.body),
			_updatedAt: r.updated_at, // sort key only; strip before returning
		});
	}
	// Low-signal captures are hidden by default: they auto-expire via the
	// aging sweep and only surface when explicitly audited.
	const visible = opts.includeLowSignal
		? out
		: out.filter((p) => p.tier === "high");
	// signalScore desc, then recency (updated_at) desc — over the FULL set.
	visible.sort(
		(a, b) =>
			b.signalScore - a.signalScore ||
			b._updatedAt.localeCompare(a._updatedAt),
	);
	return visible.slice(0, limit).map(({ _updatedAt: _drop, ...p }) => p);
}

async function resolveContext(
	repoKey: string,
	sessionId: string | null,
	turn: number | null,
	_body: string,
): Promise<CaptureContext> {
	if (!sessionId || turn == null) return { kind: "body-only" };
	let rec;
	try {
		rec = await readSession(repoKey, sessionId);
	} catch {
		return { kind: "body-only" };
	}
	if (!rec) return { kind: "body-only" };
	// 1. transcript window
	if (rec.transcriptPath && fs.existsSync(rec.transcriptPath)) {
		try {
			const turns = parseTranscriptWindow(rec.transcriptPath, turn, 3);
			if (turns.length) return { kind: "transcript", turns };
		} catch {
			/* fall through */
		}
	}
	// 2. evidence pair — match on the field, not by index
	const u = rec.evidence?.userPrompts?.find((p) => p.turn === turn);
	if (u) {
		return {
			kind: "evidence",
			userTurn: u.text,
			assistantSnippet: u.nextAssistantSnippet ?? null,
		};
	}
	// 3. body-only
	return { kind: "body-only" };
}

function parseTranscriptWindow(
	transcriptPath: string,
	centerTurn: number,
	radius: number,
): { role: string; text: string }[] {
	// Reuse the canonical transcript parser (src/lib/history/compact.ts) rather
	// than re-parsing JSONL by hand — it already normalizes the Claude/Codex
	// on-disk shapes, applies sidechain filtering, and tags each turn with a
	// numeric `turn`. Keep only turns within [centerTurn-radius,
	// centerTurn+radius]; if no turn is numerically near the center the window
	// is empty and resolveContext falls through to the evidence-pair tier.
	const turns = parseTranscript(transcriptPath);
	const win: { role: string; text: string }[] = [];
	for (const t of turns) {
		if (Math.abs(t.turn - centerTurn) <= radius) {
			win.push({ role: t.role, text: t.text });
		}
	}
	return win;
}
