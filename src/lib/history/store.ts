import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";
import type { SessionRecord } from "./types.js";

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
