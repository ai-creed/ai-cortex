import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { indexDbPath, memoryRootDir } from "./paths.js";
import type { MemoryEdge, MemoryFrontmatter, AuditRow } from "./types.js";

export type MemoryRow = {
	id: string;
	type: string;
	status: string;
	title: string;
	version: number;
	created_at: string;
	updated_at: string;
	source: string;
	confidence: number;
	pinned: number;
	body_hash: string;
	body_excerpt: string;
	get_count: number;
	last_accessed_at: string | null;
	re_extract_count: number;
	rewritten_at: string | null;
};

export type ScopeRow = { kind: "file" | "tag"; value: string };

export type FtsHit = { memoryId: string; rank: number };

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  body_hash TEXT NOT NULL,
  body_excerpt TEXT NOT NULL,
  get_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  re_extract_count INTEGER NOT NULL DEFAULT 0,
  rewritten_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);

CREATE TABLE IF NOT EXISTS memory_scope (
  memory_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (memory_id, kind, value),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scope_lookup ON memory_scope(kind, value);

CREATE TABLE IF NOT EXISTS memory_links (
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_id, rel_type),
  FOREIGN KEY (src_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_links_src ON memory_links(src_id);
CREATE INDEX IF NOT EXISTS idx_links_dst ON memory_links(dst_id);

CREATE TABLE IF NOT EXISTS memory_audit (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ts TEXT NOT NULL,
  change_type TEXT NOT NULL,
  prev_body_hash TEXT,
  prev_body TEXT,
  reason TEXT,
  agent_id TEXT,
  PRIMARY KEY (memory_id, version)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
);
`;

export class MemoryIndex {
	private db: DB;

	constructor(db: DB) {
		this.db = db;
	}

	close(): void {
		this.db.close();
	}

	rawAllTables(): string[] {
		return (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' OR type='virtual'",
				)
				.all() as { name: string }[]
		).map((r) => r.name);
	}

	rawJournalMode(): string {
		return (
			this.db.pragma("journal_mode", { simple: true }) as string
		).toLowerCase();
	}

	upsertMemory(
		fm: MemoryFrontmatter,
		opts: { bodyHash: string; bodyExcerpt: string; body: string },
	): void {
		const tx = this.db.transaction(() => {
			this.db
				.prepare(
					`
				INSERT INTO memories (id, type, status, title, version, created_at, updated_at, source, confidence, pinned, body_hash, body_excerpt)
				VALUES (@id, @type, @status, @title, @version, @createdAt, @updatedAt, @source, @confidence, @pinned, @bodyHash, @bodyExcerpt)
				ON CONFLICT(id) DO UPDATE SET
					type=excluded.type, status=excluded.status, title=excluded.title, version=excluded.version,
					updated_at=excluded.updated_at, source=excluded.source, confidence=excluded.confidence,
					pinned=excluded.pinned, body_hash=excluded.body_hash, body_excerpt=excluded.body_excerpt
			`,
				)
				.run({
					id: fm.id,
					type: fm.type,
					status: fm.status,
					title: fm.title,
					version: fm.version,
					createdAt: fm.createdAt,
					updatedAt: fm.updatedAt,
					source: fm.source,
					confidence: fm.confidence,
					pinned: fm.pinned ? 1 : 0,
					bodyHash: opts.bodyHash,
					bodyExcerpt: opts.bodyExcerpt,
				});

			this.db
				.prepare("DELETE FROM memory_scope WHERE memory_id = ?")
				.run(fm.id);
			const insScope = this.db.prepare(
				"INSERT INTO memory_scope (memory_id, kind, value) VALUES (?, ?, ?)",
			);
			for (const f of fm.scope.files) insScope.run(fm.id, "file", f);
			for (const t of fm.scope.tags) insScope.run(fm.id, "tag", t);

			this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(fm.id);
			this.db
				.prepare(
					"INSERT INTO memory_fts (memory_id, title, body) VALUES (?, ?, ?)",
				)
				.run(fm.id, fm.title, opts.body);
		});
		tx();
	}

	getMemory(id: string): MemoryRow | undefined {
		return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
			| MemoryRow
			| undefined;
	}

	scopeRows(id: string): ScopeRow[] {
		return this.db
			.prepare(
				"SELECT kind, value FROM memory_scope WHERE memory_id = ? ORDER BY kind, value",
			)
			.all(id) as ScopeRow[];
	}

	deleteMemoryRow(id: string): void {
		this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
	}

	appendAudit(row: AuditRow): void {
		this.db
			.prepare(
				`
			INSERT INTO memory_audit (memory_id, version, ts, change_type, prev_body_hash, prev_body, reason, agent_id)
			VALUES (@memoryId, @version, @ts, @changeType, @prevBodyHash, @prevBody, @reason, @agentId)
		`,
			)
			.run(row);
	}

	maxAuditVersion(memoryId: string): number {
		const row = this.db
			.prepare(
				"SELECT COALESCE(MAX(version), 0) AS v FROM memory_audit WHERE memory_id = ?",
			)
			.get(memoryId) as { v: number };
		return row.v;
	}

	auditRows(memoryId: string): AuditRow[] {
		return this.db
			.prepare(
				`
			SELECT memory_id AS memoryId, version, ts, change_type AS changeType,
			       prev_body_hash AS prevBodyHash, prev_body AS prevBody, reason, agent_id AS agentId
			FROM memory_audit WHERE memory_id = ? ORDER BY version ASC
		`,
			)
			.all(memoryId) as AuditRow[];
	}

	addLink(edge: MemoryEdge): void {
		this.db
			.prepare(
				`
			INSERT INTO memory_links (src_id, dst_id, rel_type, created_at)
			VALUES (@srcId, @dstId, @relType, @createdAt)
			ON CONFLICT DO NOTHING
		`,
			)
			.run(edge);
	}

	removeLink(srcId: string, dstId: string, relType: string): void {
		this.db
			.prepare(
				"DELETE FROM memory_links WHERE src_id = ? AND dst_id = ? AND rel_type = ?",
			)
			.run(srcId, dstId, relType);
	}

	linksFrom(srcId: string): MemoryEdge[] {
		return this.db
			.prepare(
				`
			SELECT src_id AS srcId, dst_id AS dstId, rel_type AS relType, created_at AS createdAt
			FROM memory_links WHERE src_id = ?
		`,
			)
			.all(srcId) as MemoryEdge[];
	}

	searchFts(query: string, limit: number): FtsHit[] {
		return this.db
			.prepare(
				`
			SELECT memory_id AS memoryId, rank FROM memory_fts
			WHERE memory_fts MATCH ?
			ORDER BY rank LIMIT ?
		`,
			)
			.all(query, limit) as FtsHit[];
	}

	rawDb(): DB {
		return this.db;
	}

	bumpGetCount(id: string): void {
		this.db
			.prepare(
				"UPDATE memories SET get_count = get_count + 1, last_accessed_at = ? WHERE id = ?",
			)
			.run(new Date().toISOString(), id);
	}
}

function addColumnIfMissing(
	db: DB,
	table: string,
	column: string,
	definition: string,
): void {
	try {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("duplicate column name")) throw err;
	}
}

export function openMemoryIndex(repoKey: string): MemoryIndex {
	const dir = memoryRootDir(repoKey);
	fs.mkdirSync(dir, { recursive: true });
	const db = new Database(indexDbPath(repoKey));
	db.exec(SCHEMA_SQL);
	addColumnIfMissing(db, "memories", "get_count", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "memories", "last_accessed_at", "TEXT");
	addColumnIfMissing(db, "memories", "re_extract_count", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "memories", "rewritten_at", "TEXT");
	return new MemoryIndex(db);
}
