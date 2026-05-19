// src/lib/stats/surface-events.ts
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";

const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // matches stats RETENTION_MS

export type SurfaceEvent = {
	ts: number;
	session_id: string | null;
	memoryIds: string[];
	count: number;
};

function filePath(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "adoption", "surface-events.jsonl");
}

/** Best-effort append. Never throws (caller is the latency-critical hook). */
export function appendSurfaceEvent(repoKey: string, ev: SurfaceEvent): void {
	try {
		const fp = filePath(repoKey);
		fs.mkdirSync(path.dirname(fp), { recursive: true });
		fs.appendFileSync(fp, JSON.stringify(ev) + "\n");
	} catch {
		/* telemetry is best-effort; never block the edit */
	}
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
