import path from "node:path";
import { getCacheDir } from "../cache-store.js";

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
