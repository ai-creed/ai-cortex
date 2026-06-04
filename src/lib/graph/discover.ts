// src/lib/graph/discover.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function cacheRoot(): string {
	return (
		process.env.AI_CORTEX_CACHE_HOME ??
		path.join(os.homedir(), ".cache", "ai-cortex", "v1")
	);
}

const HEX16 = /^[0-9a-f]{16}$/;

/** Immediate store-key subdirs of the cache root: 16-hex repoKeys plus the
 *  reserved literal "global". Missing root => empty list. */
export function discoverStoreKeys(): string[] {
	const root = cacheRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.filter((name) => name === "global" || HEX16.test(name));
}

/** The `<worktreeKey>.db` files present in a store dir. */
export function discoverDbFiles(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".db"))
			.map((e) => path.join(dir, e.name));
	} catch {
		return [];
	}
}
