// src/lib/memory/surface-ledger.ts
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";

const PRUNE_AGE_MS = 7 * 86_400_000;

function ledgerDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "surface-ledger");
}

function safeSessionId(sessionId: string): string {
	const s = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
	return s.length > 0 ? s.slice(0, 128) : "_";
}

export type LedgerResult = { emit: boolean; fresh: Map<string, Set<string>> };

/**
 * Per-session, per-(file, memoryId) dedup. Returns the ids freshly seen this
 * session per file (`fresh`) and `emit` = any fresh ids exist. An id shown for a
 * file once this session is never re-surfaced for that file again this session,
 * even when the matched set churns. Cache-only; best-effort IO; never throws.
 */
export function evaluateLedger(
	repoKey: string,
	sessionId: string,
	perFile: Map<string, string[]>,
): LedgerResult {
	const dir = ledgerDir(repoKey);
	const file = path.join(dir, `${safeSessionId(sessionId)}.json`);

	let prev: Record<string, string[]> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (parsed && typeof parsed === "object") {
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (Array.isArray(v))
					prev[k] = v.filter((x): x is string => typeof x === "string");
			}
		}
	} catch {
		prev = {};
	}

	const fresh = new Map<string, Set<string>>();
	const next: Record<string, string[]> = { ...prev };
	let emit = false;
	for (const [rel, ids] of perFile) {
		const seen = new Set(prev[rel] ?? []);
		const freshIds = new Set<string>();
		for (const id of ids) if (!seen.has(id)) freshIds.add(id);
		if (freshIds.size > 0) {
			emit = true;
			fresh.set(rel, freshIds);
			for (const id of freshIds) seen.add(id);
			next[rel] = [...seen];
		}
	}
	if (!emit) return { emit: false, fresh };

	try {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(next));
		fs.renameSync(tmp, file);
		pruneOld(dir);
	} catch {
		// Degrade dedup, not correctness: still emit.
	}
	return { emit: true, fresh };
}

function pruneOld(dir: string): void {
	try {
		const now = Date.now();
		for (const name of fs.readdirSync(dir)) {
			const p = path.join(dir, name);
			try {
				if (now - fs.statSync(p).mtimeMs > PRUNE_AGE_MS) fs.unlinkSync(p);
			} catch {
				/* ignore individual prune failures */
			}
		}
	} catch {
		/* ignore */
	}
}
