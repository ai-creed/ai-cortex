// src/lib/rehydrate.ts
import fs from "node:fs";
import path from "node:path";
import { renderBriefing } from "./briefing.js";
import { getCacheDir } from "./cache-store.js";
import { resolveCacheWithFreshness } from "./cache-coordinator.js";
import { IndexError, RepoIdentityError } from "./models.js";
import type { RepoCache } from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";
import { renderPinnedSection } from "./memory/briefing-pinned.js";
import { renderMemoryDigest } from "./memory/briefing-digest.js";

export type RehydrateOptions = {
	stale?: boolean;
};

export type RehydrateResult = {
	briefingPath: string;
	cacheStatus: "fresh" | "reindexed" | "stale";
	cache: RepoCache;
};

export async function rehydrateRepo(
	repoPath: string,
	options?: RehydrateOptions,
): Promise<RehydrateResult> {
	try {
		const identity = resolveRepoIdentity(repoPath);
		const { cache, cacheStatus } = await resolveCacheWithFreshness(
			identity,
			options ?? {},
		);

		const briefing = renderBriefing(cache);
		const pinned = await renderPinnedSection(identity.repoKey);
		const digest = await renderMemoryDigest(identity.repoKey);
		const extras = [pinned, digest].filter((p): p is string => Boolean(p));
		const md = extras.length
			? `${briefing}\n${extras.join("\n")}\n`
			: briefing;
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
