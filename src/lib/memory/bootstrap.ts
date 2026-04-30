// src/lib/memory/bootstrap.ts
import { listSessions, readSession } from "../history/store.js";
import { extractFromSession, type ExtractOptions } from "./extract.js";

export type BootstrapOptions = {
	limitSessions?: number;
	minConfidence?: number;
	dedupCosine?: number;
	allowReExtract?: boolean;
};

export type BootstrapReport = {
	sessionsProcessed: number;
	candidatesCreated: number;
	evidenceAppended: number;
	rejectedCount: number;
	perSession: {
		sessionId: string;
		candidatesCreated: number;
		evidenceAppended: number;
	}[];
	errors: { sessionId: string; message: string }[];
};

export async function bootstrapFromHistory(
	repoKey: string,
	opts: BootstrapOptions = {},
): Promise<BootstrapReport> {
	const ids = await listSessions(repoKey);
	const sessions = await Promise.all(
		ids.map(async (id) => {
			const rec = await readSession(repoKey, id);
			return rec ? { id, startedAt: rec.startedAt } : null;
		}),
	);
	const ordered = sessions
		.filter((s): s is { id: string; startedAt: string } => s !== null)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	const limit = opts.limitSessions ?? ordered.length;
	const slice = ordered.slice(0, limit).map((s) => s.id);

	const extractOpts: ExtractOptions = {
		minConfidence: opts.minConfidence,
		dedupCosine: opts.dedupCosine,
		allowReExtract: opts.allowReExtract ?? false,
	};

	const report: BootstrapReport = {
		sessionsProcessed: 0,
		candidatesCreated: 0,
		evidenceAppended: 0,
		rejectedCount: 0,
		perSession: [],
		errors: [],
	};

	for (const id of slice) {
		try {
			const m = await extractFromSession(repoKey, id, extractOpts);
			report.sessionsProcessed += 1;
			report.candidatesCreated += m.candidatesCreated;
			report.evidenceAppended += m.evidenceAppended;
			report.rejectedCount += m.rejectedCandidates.length;
			report.perSession.push({
				sessionId: id,
				candidatesCreated: m.candidatesCreated,
				evidenceAppended: m.evidenceAppended,
			});
		} catch (err) {
			report.errors.push({
				sessionId: id,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return report;
}
