import type { RetrieveHandle } from "./retrieve.js";
import {
	readGetEvents,
	readSurfaceEvents,
	type SurfaceEvent,
} from "../stats/surface-events.js";

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type ReconcileOpts = {
	currentSessionId: string;
	now: number;
	graceMs: number;
	retentionMs?: number;
};

/**
 * Fold "surfaced ∧ never consulted in-session" into per-(memory,file) dismissal
 * counts. Watermark-delta + session-based: each non-current session idle past
 * `graceMs` is reconciled only for surface events past its stored watermark, so
 * resumed sessions are reconciled again (never skipped) and re-runs are no-ops.
 * Cancellation uses the FULL get-events log for the session. Version-aware via
 * `index.recordDismissal`. Best-effort: callers must tolerate it doing nothing.
 */
export function reconcileDismissals(rh: RetrieveHandle, opts: ReconcileOpts): void {
	const { currentSessionId, now, graceMs } = opts;
	const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;

	const surfaces = readSurfaceEvents(rh.repoKey);
	const gets = readGetEvents(rh.repoKey);

	// session -> memoryId -> LATEST get ts. A dismissal is cancelled iff ANY get
	// for (session, memory) has ts >= the surface ts; the MAX get ts >= surface is
	// exactly that test and stays correct when a pre-surface get is followed by a
	// post-surface get (storing the earliest would wrongly count a dismissal).
	const getsBySession = new Map<string, Map<string, number>>();
	for (const g of gets) {
		if (g.session_id === null) continue;
		let m = getsBySession.get(g.session_id);
		if (!m) {
			m = new Map();
			getsBySession.set(g.session_id, m);
		}
		const prior = m.get(g.memoryId);
		if (prior === undefined || g.ts > prior) m.set(g.memoryId, g.ts);
	}

	// Group surface events by session, tracking each session's latest activity ts.
	const surfacesBySession = new Map<string, SurfaceEvent[]>();
	const lastTsBySession = new Map<string, number>();
	const bump = (sid: string, ts: number) => {
		const cur = lastTsBySession.get(sid);
		if (cur === undefined || ts > cur) lastTsBySession.set(sid, ts);
	};
	for (const s of surfaces) {
		if (s.session_id === null) continue;
		bump(s.session_id, s.ts);
		const arr = surfacesBySession.get(s.session_id);
		if (arr) arr.push(s);
		else surfacesBySession.set(s.session_id, [s]);
	}
	for (const [sid, m] of getsBySession) for (const ts of m.values()) bump(sid, ts);

	for (const [sid, events] of surfacesBySession) {
		if (sid === currentSessionId) continue;
		const lastTs = lastTsBySession.get(sid) ?? 0;
		if (lastTs >= now - graceMs) continue; // not idle past grace yet

		const watermark = rh.index.getWatermark(sid) ?? -Infinity;
		const sessionGets = getsBySession.get(sid);
		let maxTs = watermark;
		const seenPairs = new Set<string>();
		for (const ev of events) {
			if (ev.ts <= watermark) continue;
			if (ev.ts > maxTs) maxTs = ev.ts;
			const paths = ev.paths;
			if (!paths || paths.length !== ev.memoryIds.length) continue; // unattributable
			for (let i = 0; i < ev.memoryIds.length; i++) {
				const memId = ev.memoryIds[i]!;
				const file = paths[i]!;
				const pairKey = `${memId}:${file}`;
				if (seenPairs.has(pairKey)) continue; // count one dismissal per pairing per delta
				seenPairs.add(pairKey);
				const getTs = sessionGets?.get(memId);
				if (getTs !== undefined && getTs >= ev.ts) continue; // consulted → not a dismissal
				const row = rh.index.getMemory(memId);
				if (!row) continue; // memory gone; nothing to suppress
				rh.index.recordDismissal(memId, file, row.version, ev.ts);
			}
		}
		if (maxTs > watermark && maxTs !== -Infinity) rh.index.setWatermark(sid, maxTs);
	}

	rh.index.pruneReconciledSessions(now - retentionMs);
}
