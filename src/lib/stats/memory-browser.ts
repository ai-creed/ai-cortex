import fs from "node:fs";
import Database from "better-sqlite3";
import { indexDbPath } from "../memory/paths.js";
import { readMemoryFile } from "../memory/store.js";
import type { MemoryRecord } from "../memory/types.js";

// Re-export so the TUI layer imports memory view-model types from the
// stats-reader layer only — never from src/lib/memory/* directly (spec
// constraint, enforced by the isolation test in Task 12).
export type { MemoryRecord } from "../memory/types.js";

export type MemoryListItem = {
	id: string;
	type: string;
	status: string;
	title: string;
	updatedAt: string;
	pinned: boolean;
};

export type MemoryStatusGroup = {
	status: "active" | "candidate" | "deprecated";
	count: number;
	items: MemoryListItem[];
};

export type MemoryListGroups = {
	groups: MemoryStatusGroup[];
	error: string | null;
};

const STATUS_ORDER = ["active", "candidate", "deprecated"] as const;

function emptyGroups(error: string | null): MemoryListGroups {
	return {
		groups: STATUS_ORDER.map((status) => ({ status, count: 0, items: [] })),
		error,
	};
}

export function loadMemoryList(repoKey: string): MemoryListGroups {
	// indexDbPath() → getCacheDir() → assertHashedRepoKey() THROWS on a
	// non-16-hex repoKey. Readers are stateless and must never crash the UI
	// (spec: "missing/absent store → empty, not error"), so the path
	// resolution is inside the guard too.
	let dbPath: string;
	try {
		dbPath = indexDbPath(repoKey);
	} catch {
		return emptyGroups(null);
	}
	if (!fs.existsSync(dbPath)) return emptyGroups(null);
	let db: Database.Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch (e) {
		return emptyGroups(e instanceof Error ? e.message : String(e));
	}
	try {
		const rows = db
			.prepare(
				`SELECT id, type, status, title, updated_at AS updatedAt, pinned
				   FROM memories
				  WHERE status IN ('active','candidate','deprecated')
				  ORDER BY updated_at DESC`,
			)
			.all() as Array<{
			id: string;
			type: string;
			status: string;
			title: string;
			updatedAt: string;
			pinned: number;
		}>;
		const byStatus = new Map<string, MemoryListItem[]>(
			STATUS_ORDER.map((s) => [s, []]),
		);
		for (const r of rows) {
			byStatus.get(r.status)?.push({
				id: r.id,
				type: r.type,
				status: r.status,
				title: r.title,
				updatedAt: r.updatedAt,
				pinned: r.pinned === 1,
			});
		}
		return {
			groups: STATUS_ORDER.map((status) => {
				const items = byStatus.get(status) ?? [];
				return { status, count: items.length, items };
			}),
			error: null,
		};
	} catch (e) {
		return emptyGroups(e instanceof Error ? e.message : String(e));
	} finally {
		db.close();
	}
}

export type MemoryBodyResult =
	| { record: MemoryRecord; error: null }
	| { record: null; error: string };

export async function loadMemoryBody(
	repoKey: string,
	id: string,
): Promise<MemoryBodyResult> {
	try {
		const record = await readMemoryFile(repoKey, id, "memories");
		return { record, error: null };
	} catch (e) {
		return { record: null, error: e instanceof Error ? e.message : String(e) };
	}
}
