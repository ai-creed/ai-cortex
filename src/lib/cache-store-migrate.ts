import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
