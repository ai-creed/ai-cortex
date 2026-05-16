import {
	aggregate,
	aggregateAcross,
	cacheMeta,
	listProjects,
	latencyPerTool,
	memoryHealth,
	memoryHealthAcross,
	storageFootprint,
	toolCounts,
	topTools,
	type Aggregate,
	type CacheMeta,
	type LatencyStats,
	type MemoryHealth,
	type ToolStat,
} from "../lib/stats/query.js";
import type { StatsWindow } from "../lib/stats/types.js";

export type Snapshot = {
	projects: Array<{ repoKey: string; name: string | null; calls: number }>;
	/** repoKey → display name (null when packageMeta is missing). */
	projectNames: Record<string, string | null>;
	/** Cross-project aggregate when focus is null, focused project's aggregate when focus is set. */
	aggregate: Aggregate;
	/** Same focus rule as `aggregate`. */
	memory: MemoryHealth;
	storage: Record<string, number>;
	latencyPerTool: Record<string, LatencyStats>;
	topTools: ToolStat[];
	meta: CacheMeta;
	/** Recall→get fallback ratio: count(get_memory) / count(recall_memory). 0 when no recalls. */
	recallGetRatio: number;
};

function safeRatio(num: number, den: number): number {
	return den === 0 ? 0 : num / den;
}

export function readAll(
	window: StatsWindow,
	focus: string | null,
): Snapshot {
	const repoKeys = listProjects();
	const projects = repoKeys.map((rk) => {
		const a = aggregate(rk, window);
		const m = cacheMeta(rk);
		return { repoKey: rk, name: m.name, calls: a.total };
	});

	const isOverview = focus === null;
	const scope = isOverview ? repoKeys : [focus];

	const agg = isOverview
		? aggregateAcross(repoKeys, window)
		: aggregate(focus, window);

	const mem = isOverview
		? memoryHealthAcross(repoKeys)
		: memoryHealth(focus);

	const counts = toolCounts(scope, window);
	const recallGetRatio = safeRatio(
		counts.get_memory ?? 0,
		counts.recall_memory ?? 0,
	);

	const projectNames = Object.fromEntries(
		projects.map((p) => [p.repoKey, p.name]),
	);

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
	};
}
