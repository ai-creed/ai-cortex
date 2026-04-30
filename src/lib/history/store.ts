import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";
import { readVectorIndex, writeVectorIndex } from "../vector-sidecar.js";
import { appendManifestEntry, pruneManifest } from "./manifest.js";
import type { ChunkText, SessionRecord } from "./types.js";

export function historyDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "history");
}

export function sessionsDir(repoKey: string): string {
	return path.join(historyDir(repoKey), "sessions");
}

export function validateSessionId(id: string): void {
	if (!/^[\w-]+$/.test(id)) {
		throw new Error(`invalid sessionId: ${JSON.stringify(id)}`);
	}
}

export function sessionDir(repoKey: string, sessionId: string): string {
	validateSessionId(sessionId);
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

export async function acquireLock(repoKey: string, sessionId: string): Promise<AcquireResult> {
	await fs.promises.mkdir(sessionDir(repoKey, sessionId), { recursive: true });
	const p = lockPath(repoKey, sessionId);
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
	let fd: fs.promises.FileHandle | null = null;
	try {
		fd = await fs.promises.open(p, "wx");
		await fd.writeFile(payload);
		await fd.close();
		return { acquired: true };
	} catch (err) {
		if (fd) { try { await fd.close(); } catch { /* ignore */ } }
		if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	// Lock exists — check if stale.
	let existing: { pid: number; startedAt: string };
	try {
		existing = JSON.parse(await fs.promises.readFile(p, "utf8")) as { pid: number; startedAt: string };
	} catch {
		// Corrupt lock — steal.
		await fs.promises.writeFile(p, payload);
		return { acquired: true, stoleFrom: -1 };
	}
	const age = Date.now() - new Date(existing.startedAt).getTime();
	const dead = !isPidAlive(existing.pid);
	if (dead || age > LOCK_STALE_MS) {
		await fs.promises.writeFile(p, payload);
		return { acquired: true, stoleFrom: existing.pid };
	}
	return { acquired: false, reason: "locked" };
}

export async function releaseLock(repoKey: string, sessionId: string): Promise<void> {
	try {
		await fs.promises.unlink(lockPath(repoKey, sessionId));
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

export async function writeSession(repoKey: string, rec: SessionRecord): Promise<void> {
	const dir = sessionDir(repoKey, rec.id);
	await fs.promises.mkdir(dir, { recursive: true });
	const finalPath = sessionJsonPath(repoKey, rec.id);

	// Detect first write — append to manifest only when session.json doesn't exist yet
	let isFirstWrite = false;
	try {
		await fs.promises.access(finalPath);
	} catch {
		isFirstWrite = true;
	}

	const tmp = finalPath + ".tmp";
	await fs.promises.writeFile(tmp, JSON.stringify(rec, null, 2) + "\n");
	await fs.promises.rename(tmp, finalPath);

	if (isFirstWrite) {
		await appendManifestEntry(repoKey, {
			id: rec.id,
			startedAt: rec.startedAt,
			endedAt: rec.endedAt ?? undefined,
		});
	}
}

export async function readSession(repoKey: string, sessionId: string): Promise<SessionRecord | null> {
	const p = sessionJsonPath(repoKey, sessionId);
	try {
		await fs.promises.access(p);
	} catch {
		return null;
	}
	return JSON.parse(await fs.promises.readFile(p, "utf8")) as SessionRecord;
}

export async function writeAllChunks(repoKey: string, sessionId: string, chunks: ChunkText[]): Promise<void> {
	await fs.promises.mkdir(sessionDir(repoKey, sessionId), { recursive: true });
	const finalPath = chunksJsonlPath(repoKey, sessionId);
	const tmp = finalPath + ".tmp";
	const body = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length > 0 ? "\n" : "");
	await fs.promises.writeFile(tmp, body);
	await fs.promises.rename(tmp, finalPath);
}

export async function readAllChunks(repoKey: string, sessionId: string): Promise<ChunkText[]> {
	const p = chunksJsonlPath(repoKey, sessionId);
	try {
		await fs.promises.access(p);
	} catch {
		return [];
	}
	const out: ChunkText[] = [];
	for (const line of (await fs.promises.readFile(p, "utf8")).split("\n")) {
		if (line.length === 0) continue;
		out.push(JSON.parse(line) as ChunkText);
	}
	out.sort((a, b) => a.id - b.id);
	return out;
}

export async function getChunkText(repoKey: string, sessionId: string, id: number): Promise<string | null> {
	for (const c of await readAllChunks(repoKey, sessionId)) {
		if (c.id === id) return c.text;
	}
	return null;
}

export type ChunkVectorInput = { id: number; text: string; vector: Float32Array };

export type ChunkVectors = {
	byChunkId: Map<number, Float32Array>;
	dim: number;
};

export async function writeChunkVectors(
	repoKey: string,
	sessionId: string,
	input: { modelName: string; dim: number; chunks: ChunkVectorInput[] },
): Promise<void> {
	const dir = sessionDir(repoKey, sessionId);
	await fs.promises.mkdir(dir, { recursive: true });
	const matrix = new Float32Array(input.dim * input.chunks.length);
	const entries = input.chunks.map((c, i) => {
		matrix.set(c.vector, i * input.dim);
		return {
			path: `chunk:${c.id}`,
			hash: crypto.createHash("sha256").update(c.text).digest("hex"),
		};
	});
	await writeVectorIndex(dir, {
		matrix,
		meta: {
			modelName: input.modelName,
			dim: input.dim,
			count: input.chunks.length,
			entries,
		},
	});
}

export async function readChunkVectors(
	repoKey: string,
	sessionId: string,
	modelName: string,
): Promise<ChunkVectors | null> {
	const dir = sessionDir(repoKey, sessionId);
	const idx = await readVectorIndex(dir, modelName);
	if (!idx) return null;
	// Build a text→hash map from current chunks for staleness detection
	const currentHashes = new Map<number, string>();
	for (const c of await readAllChunks(repoKey, sessionId)) {
		currentHashes.set(c.id, crypto.createHash("sha256").update(c.text).digest("hex"));
	}
	const byChunkId = new Map<number, Float32Array>();
	for (let i = 0; i < idx.meta.count; i += 1) {
		const entry = idx.meta.entries[i];
		const id = parseChunkId(entry.path);
		if (id === null) continue;
		// Skip vectors whose text has changed since embedding
		if (currentHashes.get(id) !== entry.hash) continue;
		const slice = idx.matrix.slice(i * idx.meta.dim, (i + 1) * idx.meta.dim);
		byChunkId.set(id, slice);
	}
	if (byChunkId.size === 0) return null;
	return { byChunkId, dim: idx.meta.dim };
}

function parseChunkId(p: string): number | null {
	const m = /^chunk:(\d+)$/.exec(p);
	return m ? Number(m[1]) : null;
}

export async function listSessions(repoKey: string): Promise<string[]> {
	const dir = sessionsDir(repoKey);
	try {
		await fs.promises.access(dir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of await fs.promises.readdir(dir)) {
		const sjson = path.join(dir, name, "session.json");
		try {
			await fs.promises.access(sjson);
			out.push(name);
		} catch {
			// no session.json — skip
		}
	}
	return out;
}

export async function pruneSessionRaw(repoKey: string, sessionId: string, droppedAtIso: string): Promise<void> {
	const dir = sessionDir(repoKey, sessionId);
	for (const name of ["chunks.jsonl", ".vectors.bin", ".vectors.meta.json"]) {
		const p = path.join(dir, name);
		try {
			await fs.promises.unlink(p);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	const rec = await readSession(repoKey, sessionId);
	if (!rec) return;
	rec.hasRaw = false;
	rec.rawDroppedAt = droppedAtIso;
	rec.chunks = [];
	await writeSession(repoKey, rec);
}

export async function pruneSession(repoKey: string, sessionId: string): Promise<void> {
	try {
		await fs.promises.rm(sessionDir(repoKey, sessionId), { recursive: true, force: true });
	} catch {
		// already gone
	}
	const remaining = await listSessions(repoKey);
	await pruneManifest(repoKey, new Set(remaining));
}
