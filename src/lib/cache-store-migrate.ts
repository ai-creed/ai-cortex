import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

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
	const cacheRoot =
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1");
	const repoDir = path.join(cacheRoot, repoKey);
	const sentinelPath = path.join(repoDir, SENTINEL_NAME);

	if (fs.existsSync(sentinelPath)) {
		return { outcome: "already-migrated", details: [] };
	}

	const lock = await acquireMigrationLock(repoKey);
	if (lock.kind === "sentinel-found") {
		return { outcome: "already-migrated", details: [] };
	}
	const { release } = lock;
	try {
		if (fs.existsSync(sentinelPath)) {
			return { outcome: "already-migrated", details: [] };
		}

		const candidates = discoverLiteralCandidates(worktreePath);
		const details: MigrationDetail[] = [];

		for (const literalKey of candidates) {
			const literalDir = path.join(cacheRoot, literalKey);
			if (!fs.existsSync(literalDir)) continue;

			const literalClass = classifyStore(literalDir);
			const canonicalClass = classifyStore(repoDir);

			if (literalClass === "empty") {
				deleteEmptyStore(literalDir);
				details.push({ literalKey, action: "deleted-empty" });
				continue;
			}

			if (canonicalClass === "empty") {
				if (fs.existsSync(repoDir)) {
					fs.rmSync(repoDir, { recursive: true, force: true });
				}
				try {
					renameStore(literalDir, repoDir);
					details.push({ literalKey, action: "renamed" });
				} catch (err) {
					if (err instanceof WalCheckpointIncompleteError) {
						const q = quarantineStore({
							cacheRoot,
							literalKey,
							literalDir,
							canonicalDir: repoDir,
						});
						details.push({
							literalKey,
							action: "quarantined",
							reason: `wal-checkpoint-incomplete: ${q.quarantinePath}`,
						});
					} else {
						throw err;
					}
				}
				continue;
			}

			const q = quarantineStore({
				cacheRoot,
				literalKey,
				literalDir,
				canonicalDir: repoDir,
			});
			details.push({
				literalKey,
				action: "quarantined",
				reason: `both populated; quarantined to ${q.quarantinePath}`,
			});
		}

		fs.mkdirSync(repoDir, { recursive: true });
		fs.writeFileSync(
			sentinelPath,
			JSON.stringify(
				{
					migratedAt: new Date().toISOString(),
					outcomes: details,
				},
				null,
				2,
			),
		);

		const outcome = pickOutcome(details);
		return { outcome, details };
	} finally {
		release();
	}
}

function pickOutcome(details: MigrationDetail[]): MigrationOutcome {
	if (details.length === 0) return "no-op";
	const actions = new Set(details.map((d) => d.action));
	if (actions.size === 1) {
		const only = [...actions][0];
		if (only === "deleted-empty") return "deleted-empty";
		if (only === "renamed") return "renamed";
		if (only === "quarantined") return "quarantined";
	}
	return "mixed";
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

// Move a directory atomically when possible (same fs); fall back to copy + parity
// verification + delete on EXDEV. Verifies parity (file count + per-file size)
// before unlinking the source so cross-device moves never lose data.
export function safeMove(from: string, to: string): void {
	if (fs.existsSync(to)) {
		throw new Error(`safeMove: destination exists: ${to}`);
	}
	fs.mkdirSync(path.dirname(to), { recursive: true });
	try {
		fs.renameSync(from, to);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
	}
	fs.cpSync(from, to, { recursive: true });
	verifyCopyParity(from, to);
	fs.rmSync(from, { recursive: true, force: true });
}

export function renameStore(from: string, to: string): void {
	const dbPath = path.join(from, "memory", "index.sqlite");
	if (fs.existsSync(dbPath)) {
		checkpointAndVerify(dbPath);
	}
	safeMove(from, to);
}

function verifyCopyParity(from: string, to: string): void {
	const fromFiles = listAllFiles(from);
	const toFiles = listAllFiles(to);
	if (fromFiles.length !== toFiles.length) {
		throw new Error(
			`copy parity failed: ${fromFiles.length} src files vs ${toFiles.length} dst files`,
		);
	}
	for (const rel of fromFiles) {
		const a = fs.statSync(path.join(from, rel)).size;
		const b = fs.statSync(path.join(to, rel)).size;
		if (a !== b) {
			throw new Error(`copy parity failed: ${rel} size mismatch`);
		}
	}
}

function listAllFiles(root: string): string[] {
	const out: string[] = [];
	function walk(dir: string, rel: string): void {
		for (const name of fs.readdirSync(dir)) {
			const abs = path.join(dir, name);
			const r = path.join(rel, name);
			const st = fs.statSync(abs);
			if (st.isDirectory()) walk(abs, r);
			else out.push(r);
		}
	}
	walk(root, "");
	return out.sort();
}

export type LockOptions = { timeoutMs?: number; pollMs?: number };

export type LockAcquisition =
	| { kind: "acquired"; release: () => void }
	| { kind: "sentinel-found" };

export async function acquireMigrationLock(
	repoKey: string,
	opts: LockOptions = {},
): Promise<LockAcquisition> {
	const cacheRoot =
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1");
	fs.mkdirSync(cacheRoot, { recursive: true });
	const lockPath = path.join(cacheRoot, `.migration-${repoKey}.lock`);
	const sentinelPath = path.join(cacheRoot, repoKey, SENTINEL_NAME);
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const pollMs = opts.pollMs ?? 50;
	const deadline = Date.now() + timeoutMs;

	while (true) {
		if (fs.existsSync(sentinelPath)) {
			return { kind: "sentinel-found" };
		}
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return {
				kind: "acquired",
				release: () => {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						// already gone
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`acquireMigrationLock: timeout after ${timeoutMs}ms (lock at ${lockPath}; sentinel not present at ${sentinelPath})`,
			);
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
}

export type QuarantineInput = {
	cacheRoot: string;
	literalKey: string;
	literalDir: string;
	canonicalDir: string;
};

export type QuarantineResult = {
	quarantinePath: string;
};

export function quarantineStore(input: QuarantineInput): QuarantineResult {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const quarantineRoot = path.join(input.cacheRoot, ".quarantine");
	fs.mkdirSync(quarantineRoot, { recursive: true });
	const dest = path.join(quarantineRoot, `${input.literalKey}-${stamp}`);

	// Quarantine is the data-preserving path; safeMove handles EXDEV with parity.
	safeMove(input.literalDir, dest);

	const report = renderConflictReport({
		literalKey: input.literalKey,
		canonicalDir: input.canonicalDir,
		quarantineDir: dest,
	});
	fs.writeFileSync(path.join(dest, "MIGRATION-CONFLICT.md"), report);

	return { quarantinePath: dest };
}

function renderConflictReport(args: {
	literalKey: string;
	canonicalDir: string;
	quarantineDir: string;
}): string {
	const counts = readStoreCounts(args.quarantineDir);
	return [
		`# Quarantined cache directory`,
		``,
		`Literal key: \`${args.literalKey}\``,
		`Canonical hashed dir: \`${args.canonicalDir}\``,
		`Quarantined at: \`${args.quarantineDir}\``,
		``,
		`## Summary at quarantine time`,
		``,
		`- memories: ${counts.memories}`,
		`- history sessions: ${counts.sessions}`,
		`- extractor runs: ${counts.extractorRuns}`,
		``,
		`This directory was kept intact in case its contents are still needed.`,
		`Both literal and canonical stores were populated when migration ran;`,
		`row-level merging is not implemented in v1, so the literal store was`,
		`moved here to leave the canonical store unchanged.`,
		``,
	].join("\n");
}

function readStoreCounts(dir: string): {
	memories: number;
	sessions: number;
	extractorRuns: number;
} {
	let memories = 0;
	const dbPath = path.join(dir, "memory", "index.sqlite");
	if (fs.existsSync(dbPath)) {
		try {
			const db = new Database(dbPath, { readonly: true });
			try {
				const has = db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name='memories'",
					)
					.get();
				if (has) {
					const r = db
						.prepare("SELECT COUNT(*) AS c FROM memories")
						.get() as { c: number };
					memories = r.c;
				}
			} finally {
				db.close();
			}
		} catch {
			// ignore
		}
	}
	const sessionsDir = path.join(dir, "history", "sessions");
	const sessions = fs.existsSync(sessionsDir)
		? fs.readdirSync(sessionsDir).length
		: 0;
	const extractorDir = path.join(dir, "extractor-runs");
	const extractorRuns = fs.existsSync(extractorDir)
		? fs.readdirSync(extractorDir).length
		: 0;
	return { memories, sessions, extractorRuns };
}
