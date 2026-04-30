import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const tempRoots: Map<string, string> = new Map();

export async function mkRepoKey(prefix: string): Promise<string> {
	const id = `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `aicortex-${id}-`));
	process.env.AI_CORTEX_CACHE_HOME = root;
	tempRoots.set(id, root);
	return id;
}

export async function cleanupRepo(repoKey: string): Promise<void> {
	const root = tempRoots.get(repoKey);
	if (root) {
		await fs.rm(root, { recursive: true, force: true });
		tempRoots.delete(repoKey);
	}
}
