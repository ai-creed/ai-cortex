// src/lib/library/o6.ts
import { detectCurrentSession } from "../history/session-detect.js";
import { readSession } from "../history/store.js";

export interface SessionMarker {
	sessionId: string;
	turn: number; // current session turn; files opened later get a higher turn
}

// Seam over ai-cortex session-history, injectable so callers and tests do not
// need a live session. The spec permits the library to consume session-history
// for the O6 downstream-touch proxy.
export interface O6SessionSource {
	// Marker for "now", used to stamp a search with sessionId + turn.
	current(
		repoKey: string | undefined,
		cwd: string,
	): Promise<SessionMarker | null>;
	// Ordered file touches for a recorded session, for downstream-touch metrics.
	filePaths(
		sessionId: string,
		repoKey: string | undefined,
	): Promise<{ path: string; turn: number }[]>;
}

export const historyO6Source: O6SessionSource = {
	async current(repoKey, cwd) {
		try {
			if (!repoKey) return null; // no repo context -> no session correlation
			const detected = detectCurrentSession({ cwd });
			if (!detected) return null;
			const session = await readSession(repoKey, detected.sessionId);
			// turnCount is the current position; later file touches get a higher turn.
			return { sessionId: detected.sessionId, turn: session?.turnCount ?? 0 };
		} catch {
			return null; // O6 instrumentation must never break a search
		}
	},
	async filePaths(sessionId, repoKey) {
		try {
			if (!repoKey) return [];
			const session = await readSession(repoKey, sessionId);
			return (
				session?.evidence.filePaths.map((f) => ({
					path: f.path,
					turn: f.turn,
				})) ?? []
			);
		} catch {
			return [];
		}
	},
};
