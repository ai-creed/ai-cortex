// src/lib/rehydrate.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderBriefing } from "./briefing.js";
import {
	buildRepoFingerprint,
	getCacheDir,
	readCacheForWorktree,
} from "./cache-store.js";
import { indexRepo } from "./indexer.js";
import { IndexError, RepoIdentityError } from "./models.js";
import type { RepoCache } from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";

export type RehydrateOptions = {
	stale?: boolean;
};

export type RehydrateResult = {
	briefingPath: string;
	cacheStatus: "fresh" | "reindexed" | "stale";
	cache: RepoCache;
};

function isWorktreeDirty(worktreePath: string): boolean {
	const output = execFileSync(
		"git",
		["-C", worktreePath, "status", "--porcelain", "-unormal"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	return output.length > 0;
}

export function rehydrateRepo(
	repoPath: string,
	options?: RehydrateOptions,
): RehydrateResult {
	try {
		const identity = resolveRepoIdentity(repoPath);
		const cached = readCacheForWorktree(identity.repoKey, identity.worktreeKey);

		let cache: RepoCache;
		let cacheStatus: RehydrateResult["cacheStatus"];

		if (!cached) {
			cache = indexRepo(repoPath);
			cacheStatus = "reindexed";
		} else {
			const fingerprint = buildRepoFingerprint(identity.worktreePath);
			const fingerprintStale = cached.fingerprint !== fingerprint;
			const dirty =
				!fingerprintStale && isWorktreeDirty(identity.worktreePath);
			const isStale = fingerprintStale || dirty;

			if (!isStale) {
				cache = cached;
				cacheStatus = "fresh";
			} else if (options?.stale) {
				cache = cached;
				cacheStatus = "stale";
			} else {
				cache = indexRepo(repoPath);
				cacheStatus = "reindexed";
			}
		}

		const md = renderBriefing(cache);
		const dir = getCacheDir(identity.repoKey);
		fs.mkdirSync(dir, { recursive: true });
		const briefingPath = path.join(dir, `${identity.worktreeKey}.md`);
		fs.writeFileSync(briefingPath, md);

		return { briefingPath, cacheStatus, cache };
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		if (err instanceof IndexError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}
