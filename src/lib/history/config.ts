import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_RAW_DAYS = 30;
const MAX_RAW_DAYS = 90;
const MIN_RAW_DAYS = 0;

export function getHistoryDisabledFlagPath(): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "v1", "history-disabled");
}

export function isHistoryEnabled(): boolean {
	const env = process.env.AI_CORTEX_HISTORY;
	if (env === "0") return false;
	if (env === "1") return true;
	return !fs.existsSync(getHistoryDisabledFlagPath());
}

export function getRawRetentionDays(): number {
	const raw = process.env.AI_CORTEX_HISTORY_RAW_DAYS;
	if (raw === undefined) return DEFAULT_RAW_DAYS;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_RAW_DAYS;
	return Math.max(MIN_RAW_DAYS, Math.min(MAX_RAW_DAYS, Math.trunc(n)));
}
