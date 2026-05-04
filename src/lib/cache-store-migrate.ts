import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { getCacheDir } from "./cache-store.js";

export const SENTINEL_NAME = ".migration-v1-complete";

export type MigrationOutcome =
	| "already-migrated"
	| "no-op"
	| "deleted-empty"
	| "renamed"
	| "quarantined"
	| "mixed";

export type MigrationDetail = {
	literalKey: string;
	action: "skipped" | "deleted-empty" | "renamed" | "quarantined";
	reason?: string;
};

export type MigrationResult = {
	outcome: MigrationOutcome;
	details: MigrationDetail[];
};

const HASHED_RE = /^[0-9a-f]{16}$/;
const RESERVED = new Set(["global"]);

export function discoverLiteralCandidates(worktreePath: string): string[] {
	const out = new Set<string>();

	out.add(path.basename(worktreePath));

	try {
		const gitCommonDir = execFileSync(
			"git",
			["-C", worktreePath, "rev-parse", "--git-common-dir"],
			{ encoding: "utf8" },
		).trim();
		const resolvedCommon = path.resolve(worktreePath, gitCommonDir);
		out.add(path.basename(path.dirname(resolvedCommon)));
	} catch {
		// not a git repo — caller should have validated, but stay defensive
	}

	try {
		const branch = execFileSync(
			"git",
			["-C", worktreePath, "symbolic-ref", "--short", "HEAD"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		if (branch.length > 0) out.add(branch);
	} catch {
		// detached HEAD or no symbolic-ref — best-effort
	}

	for (const name of [...out]) {
		if (RESERVED.has(name) || HASHED_RE.test(name)) {
			out.delete(name);
		}
	}

	return [...out];
}

export async function runRepoKeyMigrationIfNeeded(
	repoKey: string,
	worktreePath: string,
): Promise<MigrationResult> {
	const repoDir = getCacheDir(repoKey);
	const sentinel = path.join(repoDir, SENTINEL_NAME);
	if (fs.existsSync(sentinel)) {
		return { outcome: "already-migrated", details: [] };
	}
	// Real migration logic lands in subsequent tasks.
	return { outcome: "no-op", details: [] };
}

export type StoreClassification = "empty" | "populated";

export function classifyStore(dir: string): StoreClassification {
	if (!fs.existsSync(dir)) return "empty";

	const dbPath = path.join(dir, "memory", "index.sqlite");
	if (fs.existsSync(dbPath)) {
		try {
			const db = new Database(dbPath, { readonly: true });
			try {
				const row = db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name='memories'",
					)
					.get();
				if (row) {
					const count = db
						.prepare("SELECT COUNT(*) AS c FROM memories")
						.get() as { c: number };
					if (count.c > 0) return "populated";
				}
			} finally {
				db.close();
			}
		} catch {
			// corrupt or locked — treat as populated to be safe (don't auto-delete)
			return "populated";
		}
	}

	const sessionsDir = path.join(dir, "history", "sessions");
	if (fs.existsSync(sessionsDir)) {
		const entries = fs.readdirSync(sessionsDir);
		for (const id of entries) {
			if (
				fs.existsSync(path.join(sessionsDir, id, "session.json")) ||
				fs.existsSync(path.join(sessionsDir, id, "chunks.jsonl"))
			) {
				return "populated";
			}
		}
	}

	const extractorDir = path.join(dir, "extractor-runs");
	if (fs.existsSync(extractorDir)) {
		const entries = fs.readdirSync(extractorDir);
		if (entries.some((e) => e !== "." && e !== "..")) return "populated";
	}

	return "empty";
}

export function deleteEmptyStore(dir: string): void {
	if (classifyStore(dir) !== "empty") {
		throw new Error(`Refusing to delete: ${dir} is not empty`);
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

export class WalCheckpointIncompleteError extends Error {}

export function checkpointAndVerify(dbPath: string): void {
	if (!fs.existsSync(dbPath)) return;

	let db = new Database(dbPath);
	try {
		db.pragma("busy_timeout = 0");
		const r1 = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
			busy: number;
			log: number;
			checkpointed: number;
		}>;
		if (r1[0]?.busy !== 0 || r1[0]?.log !== 0) {
			throw new WalCheckpointIncompleteError(
				`checkpoint incomplete (TRUNCATE) for ${dbPath}: ${JSON.stringify(r1[0])}`,
			);
		}
	} finally {
		db.close();
	}

	db = new Database(dbPath);
	try {
		db.pragma("busy_timeout = 0");
		const r2 = db.pragma("wal_checkpoint(PASSIVE)") as Array<{
			busy: number;
			log: number;
			checkpointed: number;
		}>;
		if (r2[0]?.log !== 0) {
			throw new WalCheckpointIncompleteError(
				`verification: frames remaining after checkpoint: ${JSON.stringify(r2[0])}`,
			);
		}
	} finally {
		db.close();
	}

	for (const sfx of ["-wal", "-shm"]) {
		const sidecar = dbPath + sfx;
		if (fs.existsSync(sidecar)) {
			try {
				fs.unlinkSync(sidecar);
			} catch {
				// best-effort; SQLite reopens may recreate them
			}
		}
	}
}
