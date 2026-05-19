// src/lib/memory/surface-ledger.ts
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getCacheDir } from "../cache-store.js";

const PRUNE_AGE_MS = 7 * 86_400_000;

function ledgerDir(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "surface-ledger");
}

function safeSessionId(sessionId: string): string {
	const s = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
	return s.length > 0 ? s.slice(0, 128) : "_";
}

function setHash(ids: string[]): string {
	const sorted = [...ids].sort();
	return createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 16);
}

export type LedgerResult = { emit: boolean };

/**
 * Per-session dedup. Returns emit=true if ANY file's matched-memory set
 * differs from what was last surfaced this session, and persists the new
 * state for emitted files. All IO is best-effort: on any error the
 * function degrades to emit=true (never suppresses incorrectly, never
 * throws). Cache-only — no repo writes (spec §3.3, §7).
 */
export function evaluateLedger(
	repoKey: string,
	sessionId: string,
	perFile: Map<string, string[]>,
): LedgerResult {
	const dir = ledgerDir(repoKey);
	const file = path.join(dir, `${safeSessionId(sessionId)}.json`);

	let prev: Record<string, string> = {};
	try {
		prev = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
		if (typeof prev !== "object" || prev === null) prev = {};
	} catch {
		prev = {};
	}

	let emit = false;
	const next: Record<string, string> = { ...prev };
	for (const [rel, ids] of perFile) {
		const h = setHash(ids);
		if (prev[rel] !== h) {
			emit = true;
			next[rel] = h;
		}
	}
	if (!emit) return { emit: false };

	try {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(next));
		fs.renameSync(tmp, file);
		pruneOld(dir);
	} catch {
		// Degrade dedup, not correctness: still emit.
	}
	return { emit: true };
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
