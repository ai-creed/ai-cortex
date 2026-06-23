// src/lib/library/store/index-store.ts
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { indexDbPath, sourceDir } from "../paths.js";
import type { Passage } from "../types.js";
import { INDEX_SCHEMA_SQL } from "./schema.js";

export interface DocRow {
	docId: string;
	relPath: string;
	docType: string;
	statusHeader: string | null;
	mtimeMs: number;
	pinned: number; // 0 | 1
	contentHash: string;
}

export interface PassageRow {
	passageId: number;
	docId: string;
	relPath: string;
	docType: string;
	statusHeader: string | null;
	mtimeMs: number;
	pinned: number;
	ordinal: number;
	headingPath: string[];
	text: string;
	lineStart: number;
	lineEnd: number;
}

// Escapes a free-text query into an FTS5 MATCH string (each token quoted).
// Mirrors src/lib/memory/index.ts ftsQuery().
function ftsQuery(raw: string): string {
	return raw
		.split(/\s+/)
		.filter((t) => /[\p{L}\p{N}]/u.test(t))
		.map((t) => `"${t.replace(/"/g, '""')}"`)
		.join(" ");
}

function vecToBuf(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// Copy into a fresh, 4-byte-aligned ArrayBuffer; sqlite Buffers may be pooled
// slices whose byteOffset is not 4-aligned, which would break a direct view.
function bufToVec(buf: Buffer, dim: number): Float32Array {
	const ab = new ArrayBuffer(dim * 4);
	new Uint8Array(ab).set(buf.subarray(0, dim * 4));
	return new Float32Array(ab);
}

// Bounded min-at-front top-K accumulator. Holds at most k items, so per-query
// memory is O(k*dim), never O(corpus).
class BoundedTopK {
	private items: { passageId: number; score: number }[] = [];
	constructor(private k: number) {}
	offer(passageId: number, score: number): void {
		if (this.k <= 0) return;
		if (this.items.length < this.k) {
			this.items.push({ passageId, score });
			if (this.items.length === this.k)
				this.items.sort((a, b) => a.score - b.score);
		} else if (score > this.items[0]!.score) {
			this.items[0] = { passageId, score };
			this.items.sort((a, b) => a.score - b.score);
		}
	}
	values(): { passageId: number; score: number }[] {
		return [...this.items].sort((a, b) => b.score - a.score);
	}
}

export class LibraryIndexStore {
	private constructor(
		private db: DB,
		private dim: number,
	) {}

	static open(sourceId: string, dim: number): LibraryIndexStore {
		fs.mkdirSync(sourceDir(sourceId), { recursive: true });
		const db = new Database(indexDbPath(sourceId));
		db.pragma("busy_timeout = 1000"); // wait briefly on a transient lock before failing
		db.exec(INDEX_SCHEMA_SQL);
		return new LibraryIndexStore(db, dim);
	}

	// Open for reading, returning null if the index cannot be opened or read
	// (corrupt or locked). The retriever uses this to skip a bad source instead of
	// crashing the whole search.
	static tryOpen(sourceId: string, dim: number): LibraryIndexStore | null {
		try {
			const store = LibraryIndexStore.open(sourceId, dim);
			store.passageCount(); // read probe; throws on a malformed db
			return store;
		} catch {
			return null;
		}
	}

	// Throws if the database is corrupt (malformed) or persistently locked, so the
	// indexer can drop and rebuild it from source per the spec. The read probe
	// catches corruption; the immediate-transaction probe catches a write lock.
	probeIntegrity(): void {
		this.db.prepare("SELECT COUNT(*) FROM passages").get();
		this.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
	}

	replaceDoc(
		doc: DocRow,
		passages: { passage: Passage; vector: Float32Array }[],
	): void {
		const tx = this.db.transaction(() => {
			this.deleteDoc(doc.docId);
			this.db
				.prepare(
					`INSERT INTO docs (doc_id, rel_path, doc_type, status_header, mtime_ms, pinned, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					doc.docId,
					doc.relPath,
					doc.docType,
					doc.statusHeader,
					doc.mtimeMs,
					doc.pinned,
					doc.contentHash,
				);
			const insP = this.db.prepare(
				`INSERT INTO passages (doc_id, ordinal, heading_path, text, line_start, line_end, vector)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			);
			const insF = this.db.prepare(
				`INSERT INTO passages_fts (passage_id, text, heading_path) VALUES (?, ?, ?)`,
			);
			for (const { passage, vector } of passages) {
				const info = insP.run(
					passage.docId,
					passage.ordinal,
					JSON.stringify(passage.headingPath),
					passage.text,
					passage.lineStart,
					passage.lineEnd,
					vecToBuf(vector),
				);
				insF.run(
					info.lastInsertRowid,
					passage.text,
					passage.headingPath.join(" "),
				);
			}
		});
		tx();
	}

	deleteDoc(docId: string): void {
		const ids = this.db
			.prepare("SELECT passage_id AS id FROM passages WHERE doc_id = ?")
			.all(docId) as { id: number }[];
		const delF = this.db.prepare(
			"DELETE FROM passages_fts WHERE passage_id = ?",
		);
		for (const { id } of ids) delF.run(id);
		this.db.prepare("DELETE FROM passages WHERE doc_id = ?").run(docId);
		this.db.prepare("DELETE FROM docs WHERE doc_id = ?").run(docId);
	}

	allDocRelPaths(): Map<string, { docId: string; contentHash: string }> {
		const rows = this.db
			.prepare(
				"SELECT doc_id AS docId, rel_path AS relPath, content_hash AS contentHash FROM docs",
			)
			.all() as { docId: string; relPath: string; contentHash: string }[];
		const map = new Map<string, { docId: string; contentHash: string }>();
		for (const r of rows)
			map.set(r.relPath, { docId: r.docId, contentHash: r.contentHash });
		return map;
	}

	searchFts(
		query: string,
		limit: number,
	): { passageId: number; rank: number }[] {
		const match = ftsQuery(query);
		if (match.length === 0) return [];
		return this.db
			.prepare(
				`SELECT passage_id AS passageId, rank FROM passages_fts
         WHERE passages_fts MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(match, limit) as { passageId: number; rank: number }[];
	}

	// Streaming bounded scan: iterate rows one at a time, score, keep only top-K.
	semanticTopK(
		query: Float32Array,
		k: number,
	): { passageId: number; score: number }[] {
		const heap = new BoundedTopK(k);
		const stmt = this.db.prepare(
			"SELECT passage_id AS id, vector FROM passages",
		);
		for (const row of stmt.iterate() as IterableIterator<{
			id: number;
			vector: Buffer;
		}>) {
			const v = bufToVec(row.vector, this.dim);
			let dot = 0;
			for (let j = 0; j < this.dim; j++) dot += query[j]! * v[j]!;
			heap.offer(row.id, dot);
		}
		return heap.values();
	}

	loadPassages(passageIds: number[]): PassageRow[] {
		if (passageIds.length === 0) return [];
		const placeholders = passageIds.map(() => "?").join(",");
		const rows = this.db
			.prepare(
				`SELECT p.passage_id AS passageId, p.doc_id AS docId, d.rel_path AS relPath,
                d.doc_type AS docType, d.status_header AS statusHeader, d.mtime_ms AS mtimeMs,
                d.pinned AS pinned, p.ordinal AS ordinal, p.heading_path AS headingPathJson,
                p.text AS text, p.line_start AS lineStart, p.line_end AS lineEnd
         FROM passages p JOIN docs d ON d.doc_id = p.doc_id
         WHERE p.passage_id IN (${placeholders})`,
			)
			.all(...passageIds) as (Omit<PassageRow, "headingPath"> & {
			headingPathJson: string;
		})[];
		return rows.map((r) => {
			const { headingPathJson, ...rest } = r;
			return { ...rest, headingPath: JSON.parse(headingPathJson) as string[] };
		});
	}

	passageCount(): number {
		return (
			this.db.prepare("SELECT COUNT(*) AS n FROM passages").get() as {
				n: number;
			}
		).n;
	}

	close(): void {
		this.db.close();
	}
}

// Used by the indexer to drop the index on a model change or on corrupt/locked
// recovery. Removes the WAL sidecars too so a fresh open starts clean.
export function removeSourceIndexFile(sourceId: string): void {
	const base = indexDbPath(sourceId);
	for (const p of [base, `${base}-wal`, `${base}-shm`])
		fs.rmSync(p, { force: true });
}
