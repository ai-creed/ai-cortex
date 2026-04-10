import { createHash } from "node:crypto";
import path from "node:path";

export function getRepoKey(repoPath: string): string {
	const normalized = path.resolve(repoPath);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
