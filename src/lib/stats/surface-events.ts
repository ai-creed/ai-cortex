// src/lib/stats/surface-events.ts
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";

const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // matches stats RETENTION_MS

export type SurfaceEvent = {
	ts: number;
	session_id: string | null;
	memoryIds: string[];
	/**
	 * Optional per-pointer tier labels parallel to `memoryIds` (same length
	 * and index correspondence). Tier 1 = "file"; Tier 2 = "tag" fallback.
	 * Omitted for back-compat with pre-Track-B events.
	 */
	tiers?: ("file" | "tag")[];
	/**
	 * Optional per-pointer repo-relative paths, parallel to `memoryIds` (same
	 * length/index). Enables per-(memory,file) dismissal attribution (L1).
	 * Omitted by pre-L1 events.
	 */
	paths?: string[];
	count: number;
};

export type WorkflowRulesEmit = {
	ts: number;
	session_id: string | null;
	source: "startup" | "resume" | "clear" | "compact";
	count: number;
};

function filePath(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "adoption", "surface-events.jsonl");
}

function workflowRulesFilePath(repoKey: string): string {
	return path.join(
		getCacheDir(repoKey),
		"adoption",
		"workflow-rules-events.jsonl",
	);
}

/**
 * Best-effort JSONL append shared by telemetry sinks. Creates the parent
 * directory as needed and swallows all errors — telemetry must never block
 * the latency-critical hook caller.
 */
function appendJsonl(fp: string, ev: unknown): void {
	try {
		fs.mkdirSync(path.dirname(fp), { recursive: true });
		fs.appendFileSync(fp, JSON.stringify(ev) + "\n");
	} catch {
		/* telemetry is best-effort; never block the edit */
	}
}

/** Best-effort append. Never throws (caller is the latency-critical hook). */
export function appendSurfaceEvent(repoKey: string, ev: SurfaceEvent): void {
	appendJsonl(filePath(repoKey), ev);
}

export type GetEvent = {
	ts: number;
	session_id: string | null;
	memoryId: string;
};

function getEventsFilePath(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "adoption", "get-events.jsonl");
}

/** Best-effort append. Never throws (caller is the latency-critical MCP path). */
export function appendGetEvent(repoKey: string, ev: GetEvent): void {
	appendJsonl(getEventsFilePath(repoKey), ev);
}

/** Tolerant reader + lazy 90-day prune, mirroring readSurfaceEvents. */
export function readGetEvents(repoKey: string): GetEvent[] {
	const fp = getEventsFilePath(repoKey);
	let raw: string;
	try {
		raw = fs.readFileSync(fp, "utf8");
	} catch {
		return [];
	}
	const cutoff = Date.now() - PRUNE_AGE_MS;
	const kept: GetEvent[] = [];
	let dropped = false;
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const e = JSON.parse(line) as GetEvent;
			if (typeof e.ts === "number" && e.ts >= cutoff) kept.push(e);
			else dropped = true;
		} catch {
			dropped = true;
		}
	}
	if (dropped) {
		try {
			const tmp = fp + ".tmp";
			fs.writeFileSync(
				tmp,
				kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
			);
			fs.renameSync(tmp, fp);
		} catch {
			/* prune is best-effort */
		}
	}
	return kept;
}

/**
 * Best-effort append for SessionStart-hook workflow-rules emit tracking.
 * Mirrors `appendSurfaceEvent`'s never-throws contract. Writes to a sibling
 * JSONL file `workflow-rules-events.jsonl` under the same cache dir.
 */
export function appendWorkflowRulesEmit(
	repoKey: string,
	event: WorkflowRulesEmit,
): void {
	appendJsonl(workflowRulesFilePath(repoKey), event);
}

/**
 * Tolerant reader + lazy retention prune. Skips malformed lines and drops
 * entries older than 90d; if anything was dropped it best-effort rewrites
 * the file with only the kept lines, so the JSONL can't grow unbounded.
 * The rewrite runs only here (aggregator / CLI / TUI path) — never in the
 * latency-critical appendSurfaceEvent hot path. Never throws.
 */
export function readSurfaceEvents(repoKey: string): SurfaceEvent[] {
	const fp = filePath(repoKey);
	let raw: string;
	try {
		raw = fs.readFileSync(fp, "utf8");
	} catch {
		return [];
	}
	const cutoff = Date.now() - PRUNE_AGE_MS;
	const kept: SurfaceEvent[] = [];
	let dropped = false;
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const e = JSON.parse(line) as SurfaceEvent;
			if (typeof e.ts === "number" && e.ts >= cutoff) kept.push(e);
			else dropped = true;
		} catch {
			dropped = true;
		}
	}
	if (dropped) {
		try {
			const tmp = fp + ".tmp";
			fs.writeFileSync(
				tmp,
				kept.map((e) => JSON.stringify(e)).join("\n") +
					(kept.length ? "\n" : ""),
			);
			fs.renameSync(tmp, fp);
		} catch {
			/* prune is best-effort; the return value is already filtered */
		}
	}
	return kept;
}
