import {
	aggregate,
	aggregateAcross,
	cacheMeta,
	listProjects,
	latencyPerTool,
	memoryHealth,
	memoryHealthAcross,
	storageFootprint,
	suggestHitCounts,
	suggestHitRate,
	toolCounts,
	topTools,
	type Aggregate,
	type CacheMeta,
	type LatencyStats,
	type MemoryHealth,
	type ToolStat,
} from "../lib/stats/query.js";
import {
	adoptionAcross,
	loadSessionAdoption,
	type AdoptionSummary,
	type SessionRow,
} from "../lib/stats/sessions.js";
import { WINDOW_MS, type StatsWindow } from "../lib/stats/types.js";

export type Snapshot = {
	projects: Array<{ repoKey: string; name: string | null; calls: number }>;
	projectNames: Record<string, string | null>;
	aggregate: Aggregate;
	memory: MemoryHealth;
	storage: Record<string, number>;
	latencyPerTool: Record<string, LatencyStats>;
	topTools: ToolStat[];
	meta: CacheMeta;
	recallGetRatio: number;
	/** Ratio 0..1; aggregate at overview, per-project at focus. */
	suggestHit: number;
	adoption: { sessions: SessionRow[]; summary: AdoptionSummary };
};

function safeRatio(num: number, den: number): number {
	return den === 0 ? 0 : num / den;
}

export function readAll(window: StatsWindow, focus: string | null): Snapshot {
	const repoKeys = listProjects();
	const projects = repoKeys.map((rk) => {
		const a = aggregate(rk, window);
		const m = cacheMeta(rk);
		return { repoKey: rk, name: m.name, calls: a.total };
	});

	const isOverview = focus === null;
	const scope = isOverview ? repoKeys : [focus];

	const agg = isOverview ? aggregateAcross(repoKeys, window) : aggregate(focus, window);
	const mem = isOverview ? memoryHealthAcross(repoKeys) : memoryHealth(focus);
	const counts = toolCounts(scope, window);
	const recallGetRatio = safeRatio(counts.get_memory ?? 0, counts.recall_memory ?? 0);

	const suggestHit = (() => {
		if (!isOverview) return suggestHitRate(focus, window);
		let hits = 0, total = 0;
		for (const rk of repoKeys) {
			const c = suggestHitCounts(rk, window);
			hits += c.hits;
			total += c.total;
		}
		return total === 0 ? 0 : hits / total;
	})();

	const projectNames = Object.fromEntries(projects.map((p) => [p.repoKey, p.name]));

	const adoption = isOverview
		? adoptionAcross(repoKeys, window)
		: loadSessionAdoption(focus, { windowMs: WINDOW_MS[window] });

	return {
		projects,
		projectNames,
		aggregate: agg,
		memory: mem,
		storage: storageFootprint(),
		latencyPerTool: isOverview ? {} : latencyPerTool(focus, window),
		topTools: isOverview ? [] : topTools(focus, window, 10),
		meta: isOverview
			? { indexedAt: null, fingerprint: null, fileCount: null, name: null }
			: cacheMeta(focus),
		recallGetRatio,
		suggestHit,
		adoption,
	};
}
