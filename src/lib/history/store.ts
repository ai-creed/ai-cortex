import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";
import { readVectorIndex, writeVectorIndex } from "../vector-sidecar.js";
import type { ChunkText, SessionRecord } from "./types.js";

export function historyDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "history");
}

export function sessionsDir(repoKey: string): string {
	return path.join(historyDir(repoKey), "sessions");
}

export function sessionDir(repoKey: string, sessionId: string): string {
	return path.join(sessionsDir(repoKey), sessionId);
}

export function sessionJsonPath(repoKey: string, sessionId: string): string {
	return path.join(sessionDir(repoKey, sessionId), "session.json");
}

export function chunksJsonlPath(repoKey: string, sessionId: string): string {
	return path.join(sessionDir(repoKey, sessionId), "chunks.jsonl");
}

export function lockPath(repoKey: string, sessionId: string): string {
	return path.join(sessionDir(repoKey, sessionId), ".lock");
}

const LOCK_STALE_MS = 10 * 60_000;

export type AcquireResult =
	| { acquired: true; stoleFrom?: number }
	| { acquired: false; reason: "locked" };

export function acquireLock(repoKey: string, sessionId: string): AcquireResult {
	fs.mkdirSync(sessionDir(repoKey, sessionId), { recursive: true });
	const p = lockPath(repoKey, sessionId);
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
	try {
		const fd = fs.openSync(p, "wx");
		fs.writeSync(fd, payload);
		fs.closeSync(fd);
		return { acquired: true };
	} catch (err) {
		if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	// Lock exists — check if stale.
	let existing: { pid: number; startedAt: string };
	try {
		existing = JSON.parse(fs.readFileSync(p, "utf8")) as { pid: number; startedAt: string };
	} catch {
		// Corrupt lock — steal.
		fs.writeFileSync(p, payload);
		return { acquired: true, stoleFrom: -1 };
	}
	const age = Date.now() - new Date(existing.startedAt).getTime();
	const dead = !isPidAlive(existing.pid);
	if (dead || age > LOCK_STALE_MS) {
		fs.writeFileSync(p, payload);
		return { acquired: true, stoleFrom: existing.pid };
	}
	return { acquired: false, reason: "locked" };
}

export function releaseLock(repoKey: string, sessionId: string): void {
	try {
		fs.unlinkSync(lockPath(repoKey, sessionId));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function writeSession(repoKey: string, rec: SessionRecord): void {
	const dir = sessionDir(repoKey, rec.id);
	fs.mkdirSync(dir, { recursive: true });
	const finalPath = sessionJsonPath(repoKey, rec.id);
	const tmp = finalPath + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
	fs.renameSync(tmp, finalPath);
}

export function readSession(repoKey: string, sessionId: string): SessionRecord | null {
	const p = sessionJsonPath(repoKey, sessionId);
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf8")) as SessionRecord;
}

export function writeAllChunks(repoKey: string, sessionId: string, chunks: ChunkText[]): void {
	fs.mkdirSync(sessionDir(repoKey, sessionId), { recursive: true });
	const finalPath = chunksJsonlPath(repoKey, sessionId);
	const tmp = finalPath + ".tmp";
	const body = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length > 0 ? "\n" : "");
	fs.writeFileSync(tmp, body);
	fs.renameSync(tmp, finalPath);
}

export function readAllChunks(repoKey: string, sessionId: string): ChunkText[] {
	const p = chunksJsonlPath(repoKey, sessionId);
	if (!fs.existsSync(p)) return [];
	const out: ChunkText[] = [];
	for (const line of fs.readFileSync(p, "utf8").split("\n")) {
		if (line.length === 0) continue;
		out.push(JSON.parse(line) as ChunkText);
	}
	out.sort((a, b) => a.id - b.id);
	return out;
}

export function getChunkText(repoKey: string, sessionId: string, id: number): string | null {
	for (const c of readAllChunks(repoKey, sessionId)) {
		if (c.id === id) return c.text;
	}
	return null;
}

export type ChunkVectorInput = { id: number; text: string; vector: Float32Array };

export type ChunkVectors = {
	byChunkId: Map<number, Float32Array>;
	dim: number;
};

export function writeChunkVectors(
	repoKey: string,
	sessionId: string,
	input: { modelName: string; dim: number; chunks: ChunkVectorInput[] },
): void {
	const dir = sessionDir(repoKey, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const matrix = new Float32Array(input.dim * input.chunks.length);
	const entries = input.chunks.map((c, i) => {
		matrix.set(c.vector, i * input.dim);
		return {
			path: `chunk:${c.id}`,
			hash: crypto.createHash("sha256").update(c.text).digest("hex"),
		};
	});
	writeVectorIndex(dir, {
		matrix,
		meta: {
			modelName: input.modelName,
			dim: input.dim,
			count: input.chunks.length,
			entries,
		},
	});
}

export function readChunkVectors(
	repoKey: string,
	sessionId: string,
	modelName: string,
): ChunkVectors | null {
	const dir = sessionDir(repoKey, sessionId);
	const idx = readVectorIndex(dir, modelName);
	if (!idx) return null;
	const byChunkId = new Map<number, Float32Array>();
	for (let i = 0; i < idx.meta.count; i += 1) {
		const entry = idx.meta.entries[i];
		const id = parseChunkId(entry.path);
		if (id === null) continue;
		const slice = idx.matrix.slice(i * idx.meta.dim, (i + 1) * idx.meta.dim);
		byChunkId.set(id, slice);
	}
	return { byChunkId, dim: idx.meta.dim };
}

function parseChunkId(p: string): number | null {
	const m = /^chunk:(\d+)$/.exec(p);
	return m ? Number(m[1]) : null;
}

export function listSessions(repoKey: string): string[] {
	const dir = sessionsDir(repoKey);
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of fs.readdirSync(dir)) {
		const sjson = path.join(dir, name, "session.json");
		if (fs.existsSync(sjson)) out.push(name);
	}
	return out;
}

export function pruneSessionRaw(repoKey: string, sessionId: string, droppedAtIso: string): void {
	const dir = sessionDir(repoKey, sessionId);
	for (const name of ["chunks.jsonl", ".vectors.bin", ".vectors.meta.json"]) {
		const p = path.join(dir, name);
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}
	const rec = readSession(repoKey, sessionId);
	if (!rec) return;
	rec.hasRaw = false;
	rec.rawDroppedAt = droppedAtIso;
	rec.chunks = [];
	writeSession(repoKey, rec);
}

export function pruneSession(repoKey: string, sessionId: string): void {
	const dir = sessionDir(repoKey, sessionId);
	if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
