import fs from "node:fs";
import path from "node:path";
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
