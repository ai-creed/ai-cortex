// src/lib/stats/backfill.ts
//
// One-shot backfill: scan a repo's session-history JSON files, synthesize
// stats rows (synthetic=1) so the TUI shows real volume data for repos
// that pre-date the live stats sink.
//
// Idempotency model: backfillRepo deletes every existing synthetic row
// before re-inserting. Live (synthetic=0) rows are never touched.

import fs from "node:fs";
import { sessionsDir, sessionJsonPath } from "../history/store.js";
import type { SessionRecord } from "../history/types.js";
import { openSink, writeEvent } from "./sink.js";
import { listProjects } from "./query.js";
import { isCortexTool } from "./tool-names.js";

export type BackfillResult = {
	repoKey: string;
	sessionsScanned: number;
	rowsInserted: number;
	skipped: { nonCortex: number; missingSession: number };
};

export function backfillRepo(repoKey: string): BackfillResult {
	const result: BackfillResult = {
		repoKey,
		sessionsScanned: 0,
		rowsInserted: 0,
		skipped: { nonCortex: 0, missingSession: 0 },
	};
	const sink = openSink(repoKey);
	try {
		// Idempotency: replace prior synthetic rows wholesale.
		sink.db.prepare("DELETE FROM tool_calls WHERE synthetic = 1").run();

		const dir = sessionsDir(repoKey);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// No history at all for this repo — nothing to backfill.
			return result;
		}

		const insertMany = sink.db.transaction(
			(rows: Array<Parameters<typeof writeEvent>[1]>) => {
				for (const ev of rows) writeEvent(sink, ev);
			},
		);

		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const sjsonPath = sessionJsonPath(repoKey, e.name);
			let raw: string;
			try {
				raw = fs.readFileSync(sjsonPath, "utf8");
			} catch {
				result.skipped.missingSession += 1;
				continue;
			}
			let session: SessionRecord;
			try {
				session = JSON.parse(raw) as SessionRecord;
			} catch {
				result.skipped.missingSession += 1;
				continue;
			}
			const ts = Date.parse(session.startedAt);
			if (!Number.isFinite(ts)) {
				result.skipped.missingSession += 1;
				continue;
			}
			const calls = session.evidence?.toolCalls;
			if (!Array.isArray(calls)) {
				// Session lacks evidence layer (older schema, partial write).
				result.sessionsScanned += 1;
				continue;
			}
			const rows: Array<Parameters<typeof writeEvent>[1]> = [];
			for (const call of calls) {
				if (!call || typeof call.name !== "string") {
					result.skipped.nonCortex += 1;
					continue;
				}
				if (!isCortexTool(call.name)) {
					result.skipped.nonCortex += 1;
					continue;
				}
				rows.push({
					ts,
					tool: call.name,
					dur_ms: 0,
					status: "ok",
					synthetic: 1,
					session_id: e.name,
					query_len:
						typeof call.args === "string" ? call.args.length : undefined,
				});
			}
			if (rows.length > 0) {
				insertMany(rows);
				result.rowsInserted += rows.length;
			}
			result.sessionsScanned += 1;
		}
	} finally {
		sink.close();
	}
	return result;
}

export function backfillAll(): BackfillResult[] {
	return listProjects().map((repoKey) => backfillRepo(repoKey));
}
