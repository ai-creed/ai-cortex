// src/lib/stats/cli/sessions.ts
import { loadSessionAdoption } from "../sessions.js";
import { WINDOW_MS, type StatsWindow } from "../types.js";

export function runStatsSessions(
	opts: { repoKey: string; window: StatsWindow; json: boolean },
	write: (s: string) => void,
): number {
	const { sessions, summary } = loadSessionAdoption(opts.repoKey, {
		windowMs: WINDOW_MS[opts.window],
	});
	if (opts.json) {
		write(JSON.stringify({ sessions, summary }, null, 2) + "\n");
		return 0;
	}
	const p = (n: number) => `${n.toFixed(0)}%`;
	write(
		`Adoption — window ${opts.window} — ${summary.sessionCount} sessions\n\n` +
			`  memory used:     ${p(summary.memoryUsedPct)} (${summary.histogram.used}/${summary.sessionCount}) — sessions where get_memory or record_memory ran\n` +
			`  recall→get:      ${p(summary.recallToGetPct)} — recall sessions that then did get_memory (the cardinal pattern)\n` +
			`  surface→get:     ${p(summary.surfaceToGetPct)} — surfacings followed by a later get_memory same session\n` +
			`  extract→cleanup: ${p(summary.extractCleanupPct)} — Σ cleanup ÷ Σ extracted candidates (window-level)\n` +
			`  unattributed:    ${(summary.unattributedShare * 100).toFixed(0)}% of events — share with no session_id (lower = numbers more reliable)\n\n`,
	);
	for (const s of sessions.slice(0, 50)) {
		write(
			`  ${s.sessionId.slice(0, 18).padEnd(18)}  calls=${String(s.totalCalls).padStart(4)}  ` +
				`recall=${s.recall} get=${s.get} rec=${s.record} surf=${s.surfacings}  ` +
				`${s.memoryUsed ? "USED" : "—"}\n`,
		);
	}
	write(
		"\nCombined-read patterns + calibration debt: docs/shared/adoption-metrics.md\n",
	);
	return 0;
}
