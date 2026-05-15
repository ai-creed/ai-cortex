// src/lib/stats/types.ts

export type ToolStatus = "ok" | "error";

export type CacheStatus = "fresh" | "stale" | "miss" | "reindexed";

export type SuggestMode = "fast" | "deep" | "semantic";

export type StatsParamFields = {
	query_len?: number;
};

export type StatsResultFields = {
	cache_status?: CacheStatus;
	mode?: SuggestMode;
	result_count?: number;
};

export type StatsEvent = {
	ts: number;
	tool: string;
	dur_ms: number;
	status: ToolStatus;
	err_class?: string | null;
	err_code?: string | null;
} & StatsResultFields &
	StatsParamFields;

export type StatsWindow = "1h" | "24h" | "7d" | "30d";

export const WINDOW_MS: Record<StatsWindow, number> = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};
