// src/lib/history/manifest.ts
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../cache-store.js";

export type ManifestEntry = {
	id: string;
	startedAt: string;
	endedAt?: string;
};

function manifestPath(repoKey: string): string {
	return path.join(getCacheDir(repoKey), "history", "manifest.jsonl");
}

export async function appendManifestEntry(
	repoKey: string,
	entry: ManifestEntry,
): Promise<void> {
	const p = manifestPath(repoKey);
	await fs.promises.mkdir(path.dirname(p), { recursive: true });
	await fs.promises.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
}

export async function readManifest(repoKey: string): Promise<ManifestEntry[]> {
	const p = manifestPath(repoKey);
	let raw: string;
	try {
		raw = await fs.promises.readFile(p, "utf8");
	} catch {
		return [];
	}

	// Parse all lines and deduplicate by id (last-write-wins)
	const byId = new Map<string, ManifestEntry>();
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as ManifestEntry;
			byId.set(entry.id, entry);
		} catch {
			// skip malformed lines
		}
	}
	return Array.from(byId.values());
}

export async function pruneManifest(
	repoKey: string,
	activeSessions: Set<string>,
): Promise<void> {
	const p = manifestPath(repoKey);
	try {
		await fs.promises.access(p);
	} catch {
		return; // manifest doesn't exist — no-op
	}

	const entries = await readManifest(repoKey);
	const kept = entries.filter((e) => activeSessions.has(e.id));
	const content = kept.map((e) => JSON.stringify(e) + "\n").join("");
	const tmp = p + ".tmp";
	await fs.promises.writeFile(tmp, content, "utf8");
	await fs.promises.rename(tmp, p);
}
