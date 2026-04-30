import fs from "node:fs";
import path from "node:path";
import {
	acquireLock,
	releaseLock,
	readSession,
	writeSession,
	writeAllChunks,
	chunksJsonlPath,
	sessionDir,
	readAllChunks,
	writeChunkVectors,
	readChunkVectors,
} from "./store.js";
import {
	parseTranscript,
	extractEvidence,
	liftHarnessSummary,
	chunkTurns,
} from "./compact.js";
import { isHistoryEnabled } from "./config.js";
import { HISTORY_SCHEMA_VERSION } from "./types.js";
import type { SessionRecord } from "./types.js";
import { getProvider, MODEL_NAME, EMBEDDING_DIM } from "../embed-provider.js";

export type CaptureInput = {
	repoKey: string;
	sessionId: string;
	transcriptPath: string;
	embed: boolean;
};

export type CaptureResult =
	| { status: "captured"; turnsProcessed: number }
	| { status: "up-to-date" }
	| { status: "skipped-locked" }
	| { status: "disabled" }
	| { status: "error"; message: string };

export async function captureSession(
	input: CaptureInput,
): Promise<CaptureResult> {
	// Enabled check FIRST — before any disk read or lock acquisition.
	// Hooks call into this; `ai-cortex history off` must stop them too.
	if (!isHistoryEnabled()) return { status: "disabled" };

	const lock = await acquireLock(input.repoKey, input.sessionId);
	if (!lock.acquired) return { status: "skipped-locked" };

	try {
		const turns = parseTranscript(input.transcriptPath);
		const existing = await readSession(input.repoKey, input.sessionId);
		const lastProcessed = existing?.lastProcessedTurn ?? -1;
		const newTurns = turns.filter((t) => t.turn > lastProcessed);

		// Up-to-date only if no new turns AND on-disk side files match the recorded state.
		// Crash-resume: if session.json says hasRaw but chunks.jsonl is missing, re-run.
		if (
			newTurns.length === 0 &&
			existing &&
			(await isCompleteOnDisk(input, existing))
		) {
			return { status: "up-to-date" };
		}

		const allTurns = turns;
		const evidence = extractEvidence(allTurns);
		const summary = liftHarnessSummary(allTurns);
		const chunks = chunkTurns(allTurns);

		const startedAt = existing?.startedAt ?? new Date().toISOString();
		const rec: SessionRecord = {
			version: HISTORY_SCHEMA_VERSION,
			id: input.sessionId,
			startedAt,
			endedAt: new Date().toISOString(),
			turnCount: allTurns.length,
			lastProcessedTurn: allTurns[allTurns.length - 1]?.turn ?? lastProcessed,
			hasSummary: summary.length > 0,
			hasRaw: true,
			rawDroppedAt: null,
			transcriptPath: input.transcriptPath,
			summary,
			evidence,
			chunks: chunks.map((c) => ({
				id: c.id,
				tokenStart: c.tokenStart,
				tokenEnd: c.tokenEnd,
				preview: c.preview,
			})),
		};

		// Commit-last ordering: write side files first, session.json last.
		// If we crash before writeSession, session.json (or absence thereof) reflects the
		// PRIOR state — next run will detect inconsistency or new turns and re-process.
		await writeAllChunks(
			input.repoKey,
			input.sessionId,
			chunks.map((c) => ({ id: c.id, text: c.text })),
		);
		if (input.embed && chunks.length > 0) {
			const provider = await getProvider();
			const vectors = await provider.embed(chunks.map((c) => c.text));
			await writeChunkVectors(input.repoKey, input.sessionId, {
				modelName: MODEL_NAME,
				dim: EMBEDDING_DIM,
				chunks: chunks.map((c, i) => ({
					id: c.id,
					text: c.text,
					vector: vectors[i],
				})),
			});
		}
		await writeSession(input.repoKey, rec);

		// Best-effort extractor — never fails capture.
		try {
			const { extractFromSession } = await import("../memory/extract.js");
			await extractFromSession(input.repoKey, input.sessionId);
		} catch (err) {
			process.stderr.write(
				`[ai-cortex] extractor failed for session=${input.sessionId}: ${
					err instanceof Error ? err.message : String(err)
				}\n`,
			);
		}

		return {
			status: "captured",
			turnsProcessed: newTurns.length === 0 ? allTurns.length : newTurns.length,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { status: "error", message: msg };
	} finally {
		await releaseLock(input.repoKey, input.sessionId);
	}
}

async function isCompleteOnDisk(
	input: CaptureInput,
	rec: SessionRecord,
): Promise<boolean> {
	if (!rec.hasRaw) {
		const dir = sessionDir(input.repoKey, input.sessionId);
		const chunksExists = await fs.promises
			.access(chunksJsonlPath(input.repoKey, input.sessionId))
			.then(
				() => true,
				() => false,
			);
		const vecExists = await fs.promises
			.access(path.join(dir, ".vectors.bin"))
			.then(
				() => true,
				() => false,
			);
		return !chunksExists && !vecExists;
	}
	const onDiskChunks = await readAllChunks(input.repoKey, input.sessionId);
	if (onDiskChunks.length !== rec.chunks.length) return false;
	if (input.embed) {
		const vecs = await readChunkVectors(
			input.repoKey,
			input.sessionId,
			MODEL_NAME,
		);
		if (!vecs || vecs.byChunkId.size !== rec.chunks.length) return false;
	}
	return true;
}
