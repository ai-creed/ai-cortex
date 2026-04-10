// src/lib/repo-identity.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { RepoIdentityError } from "./models.js";
import type { RepoIdentity } from "./models.js";

function execGit(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"]
	}).trimEnd();
}

function sha16(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveRepoIdentity(inputPath: string): RepoIdentity {
	try {
		const resolved = path.resolve(inputPath);
		const gitCommonDir = path.resolve(execGit(resolved, ["rev-parse", "--git-common-dir"]));
		const worktreePath = path.resolve(execGit(resolved, ["rev-parse", "--show-toplevel"]));
		return {
			repoKey: sha16(gitCommonDir),
			worktreeKey: sha16(worktreePath),
			gitCommonDir,
			worktreePath
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new RepoIdentityError(`Cannot resolve git repo at ${inputPath}: ${msg}`);
	}
}
