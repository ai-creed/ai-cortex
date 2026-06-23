// src/lib/library/store/schema.ts

// Standalone FTS5 table (passage_id UNINDEXED) mirrors the memory store idiom in
// src/lib/memory/index.ts: no external-content triggers, query returns passage_id.
export const INDEX_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS docs (
  doc_id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  status_header TEXT,
  mtime_ms REAL NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passages (
  passage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading_path TEXT NOT NULL,
  text TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passages_doc ON passages(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
  passage_id UNINDEXED,
  text,
  heading_path,
  tokenize='porter unicode61'
);
`;

export const ANNOTATION_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS annotations (
  doc_id TEXT PRIMARY KEY,
  summary TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  topics TEXT NOT NULL DEFAULT '[]',
  value TEXT,
  related TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL,
  model TEXT,
  ts TEXT NOT NULL
);
`;
