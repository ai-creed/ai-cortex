// src/lib/seq-lock.ts
import fs from "node:fs";
import Database from "better-sqlite3";
import { STORE_FORMAT_VERSION } from "./cache-store-sqlite.js";

export function seqDbPathFor(dbPath: string): string {
	return dbPath.replace(/\.db$/u, "") + ".seq.db";
}

export type SeqHandle = { read(): number; write(n: number): void };

/** Per-store critical section (spec B4). Exclusion is SQLite's own file lock
 *  on the sidecar, released by the OS on process exit, so there is no stale
 *  lock state and no reclamation. */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
/** Test-only seam: shorten the busy timeout; null restores the 15 s default. */
export function setSequenceLockTimeoutForTests(ms: number | null): void {
	lockTimeoutMs = ms ?? DEFAULT_LOCK_TIMEOUT_MS;
}

export function withSequenceLock<T>(dbPath: string, fn: (seq: SeqHandle) => T): T {
	const seqPath = seqDbPathFor(dbPath);
	const db = new Database(seqPath);
	try {
		db.pragma(`busy_timeout = ${lockTimeoutMs}`);
		// Take the lock first, so a waiter blocks in the busy handler exactly once;
		// the table bootstrap then runs inside the same transaction.
		try {
			db.exec("BEGIN IMMEDIATE");
		} catch (err) {
			if ((err as { code?: string }).code === "SQLITE_BUSY") {
				throw new Error(
					`ai-cortex: index sequence lock timed out after ${lockTimeoutMs / 1000} s waiting on ${seqPath}`,
					{ cause: err },
				);
			}
			throw err;
		}
		let committed = false;
		try {
			db.exec("CREATE TABLE IF NOT EXISTS seq (n INTEGER NOT NULL)");
			db.exec("INSERT INTO seq (n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM seq)");
			const result = fn({
				read: () => (db.prepare("SELECT n FROM seq").get() as { n: number }).n,
				write: (n) => {
					db.prepare("UPDATE seq SET n = ?").run(n);
				},
			});
			db.exec("COMMIT");
			committed = true;
			return result;
		} finally {
			if (!committed) {
				try {
					db.exec("ROLLBACK");
				} catch {
					/* connection already out of a transaction */
				}
			}
		}
	} finally {
		db.close();
	}
}

/** indexSeq of the canonical store, or 0 when it is missing, unreadable, of a
 *  different store format, or has no indexSeq meta row. */
export function readCanonicalIndexSeq(dbPath: string): number {
	if (!fs.existsSync(dbPath)) return 0;
	let db: InstanceType<typeof Database> | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		if (db.pragma("user_version", { simple: true }) !== STORE_FORMAT_VERSION) return 0;
		const row = db.prepare("SELECT value FROM meta WHERE key = 'indexSeq'").get() as { value: string } | undefined;
		const n = Number(row?.value ?? "0");
		return Number.isSafeInteger(n) && n >= 0 ? n : 0;
	} catch {
		return 0;
	} finally {
		db?.close();
	}
}
