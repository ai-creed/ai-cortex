import { it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";
import { openRetrieve } from "../../../../src/lib/memory/retrieve.js";
import { appendSurfaceEvent, appendGetEvent } from "../../../../src/lib/stats/surface-events.js";
import { reconcileDismissals } from "../../../../src/lib/memory/surface-dismissal.js";

let repoKey: string;
beforeEach(async () => { repoKey = await mkRepoKey("surface-dismissal"); });
afterEach(async () => { await cleanupRepo(repoKey); });

async function mkMemory(file: string, title: string): Promise<string> {
	const lc = await openLifecycle(repoKey, { agentId: "t" });
	try {
		return await createMemory(lc, {
			type: "decision", title, body: "## r\nx",
			scope: { files: [file], tags: [] }, source: "explicit",
		});
	} finally { lc.close(); }
}

const GRACE = 1000;
// Anchor all timestamps to now so they survive the 90-day prune in readSurfaceEvents/readGetEvents.
const BASE = Date.now();

it("counts a dismissal only after the session is idle past grace", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
	const rh = openRetrieve(repoKey);
	try {
		// Not idle yet: now-grace < last event ts.
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 500, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(false);
		// Idle past grace:
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 100 + GRACE + 1, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(true);
	} finally { rh.close(); }
});

it("does NOT count when the memory was consulted in that session", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
	appendGetEvent(repoKey, { ts: BASE + 150, session_id: "sA", memoryId: id }); // consulted after surface
	const rh = openRetrieve(repoKey);
	try {
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 5000, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(false);
	} finally { rh.close(); }
});

it("a later same-session get cancels even when an earlier get preceded the surface", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
	appendGetEvent(repoKey, { ts: BASE + 50, session_id: "sA", memoryId: id });  // BEFORE surface
	appendGetEvent(repoKey, { ts: BASE + 150, session_id: "sA", memoryId: id }); // AFTER surface → must cancel
	const rh = openRetrieve(repoKey);
	try {
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 5000, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(false); // earliest-get bug would count this
	} finally { rh.close(); }
});

it("a get-event in a DIFFERENT session does not cancel the dismissal (session divergence fallback)", async () => {
	// Models the session-attribution divergence case: the hook stamped the surface
	// under "sA", but resolveLoggedSessionId resolved a different id ("sB") for the
	// get. Cancellation must respect session_id — a get in sB must NOT cancel sA's
	// dismissal — and must never crash. An impl that cancels by memoryId alone fails.
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
	appendGetEvent(repoKey, { ts: BASE + 150, session_id: "sB", memoryId: id }); // divergent session
	const rh = openRetrieve(repoKey);
	try {
		expect(() =>
			reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 5000, graceMs: GRACE }),
		).not.toThrow();
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(true); // counted for sA, not cancelled by sB
	} finally { rh.close(); }
});

it("never counts the current session", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "cur", memoryIds: [id], paths: ["a.ts"], count: 1 });
	const rh = openRetrieve(repoKey);
	try {
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 5000, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(false);
	} finally { rh.close(); }
});

it("B2: later same-session events past the watermark are reconciled, not skipped", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
	const rh = openRetrieve(repoKey);
	try {
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 100 + GRACE + 1, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 2)).toBe(false); // count 1
		// Session sA resumes much later with a NEW surface (past the watermark):
		appendSurfaceEvent(repoKey, { ts: BASE + 10000, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 10000 + GRACE + 1, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 2)).toBe(true); // count advanced to 2
	} finally { rh.close(); }
});

it("re-running with no new events is a no-op (no double count)", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], paths: ["a.ts"], count: 1 });
	const rh = openRetrieve(repoKey);
	try {
		const now = BASE + 100 + GRACE + 1;
		reconcileDismissals(rh, { currentSessionId: "cur", now, graceMs: GRACE });
		reconcileDismissals(rh, { currentSessionId: "cur", now, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 2)).toBe(false); // still count 1, not 2
	} finally { rh.close(); }
});

it("skips surface events with no paths (legacy) and null sessions", async () => {
	const id = await mkMemory("a.ts", "m");
	appendSurfaceEvent(repoKey, { ts: BASE + 100, session_id: "sA", memoryIds: [id], count: 1 }); // no paths
	appendSurfaceEvent(repoKey, { ts: BASE + 200, session_id: null, memoryIds: [id], paths: ["a.ts"], count: 1 });
	const rh = openRetrieve(repoKey);
	try {
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 5000, graceMs: GRACE });
		expect(rh.index.isDismissed(id, "a.ts", 1, 1)).toBe(false);
	} finally { rh.close(); }
});

it("B3: a version bump processed THROUGH the reconciler resets the count below K", async () => {
	const id = await mkMemory("a.ts", "m");
	const rh = openRetrieve(repoKey);
	try {
		// Seed a suppressed pairing at version 1 (K=2).
		rh.index.recordDismissal(id, "a.ts", 1, BASE + 1000);
		rh.index.recordDismissal(id, "a.ts", 1, BASE + 2000);
		expect(rh.index.isDismissed(id, "a.ts", 1, 2)).toBe(true);

		// The memory is actually rewritten → its CURRENT version becomes 2 in the index.
		rh.index.rawDb().prepare("UPDATE memories SET version = 2 WHERE id = ?").run(id);

		// One new surface in a new session, no consult, idle past grace. The reconciler
		// must read the CURRENT version (2) from the index and RESET the stale v1 row —
		// not increment it to K+1. (A reconciler that passed a wrong/stale version here
		// would fail this test.)
		appendSurfaceEvent(repoKey, { ts: BASE + 9000, session_id: "sB", memoryIds: [id], paths: ["a.ts"], count: 1 });
		reconcileDismissals(rh, { currentSessionId: "cur", now: BASE + 9000 + GRACE + 1, graceMs: GRACE });

		expect(rh.index.isDismissed(id, "a.ts", 2, 2)).toBe(false); // reset to 1 under v2, < K
		expect(rh.index.isDismissed(id, "a.ts", 1, 2)).toBe(false); // stale version never suppresses
	} finally { rh.close(); }
});
