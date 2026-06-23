// src/lib/library/store/annotation-store.ts
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { annotationsDbPath, sourceDir } from "../paths.js";
import type { Annotation, ValueSignal } from "../types.js";
import { ANNOTATION_SCHEMA_SQL } from "./schema.js";

interface Row {
	doc_id: string;
	summary: string | null;
	labels: string;
	topics: string;
	value: string | null;
	related: string;
	author: string;
	model: string | null;
	ts: string;
}

export class LibraryAnnotationStore {
	private constructor(private db: DB) {}

	static open(sourceId: string): LibraryAnnotationStore {
		fs.mkdirSync(sourceDir(sourceId), { recursive: true });
		const db = new Database(annotationsDbPath(sourceId));
		db.exec(ANNOTATION_SCHEMA_SQL);
		return new LibraryAnnotationStore(db);
	}

	upsert(a: Annotation): void {
		this.db
			.prepare(
				`INSERT INTO annotations (doc_id, summary, labels, topics, value, related, author, model, ts)
         VALUES (@doc_id, @summary, @labels, @topics, @value, @related, @author, @model, @ts)
         ON CONFLICT(doc_id) DO UPDATE SET
           summary=excluded.summary, labels=excluded.labels, topics=excluded.topics,
           value=excluded.value, related=excluded.related, author=excluded.author,
           model=excluded.model, ts=excluded.ts`,
			)
			.run({
				doc_id: a.docId,
				summary: a.summary ?? null,
				labels: JSON.stringify(a.labels),
				topics: JSON.stringify(a.topics),
				value: a.value ? JSON.stringify(a.value) : null,
				related: JSON.stringify(a.relatedDocs),
				author: a.provenance.author,
				model: a.provenance.model ?? null,
				ts: a.provenance.timestamp,
			});
	}

	get(docId: string): Annotation | null {
		const r = this.db
			.prepare("SELECT * FROM annotations WHERE doc_id = ?")
			.get(docId) as Row | undefined;
		if (!r) return null;
		return {
			docId: r.doc_id,
			summary: r.summary ?? undefined,
			labels: JSON.parse(r.labels) as string[],
			topics: JSON.parse(r.topics) as string[],
			value: r.value
				? (JSON.parse(r.value) as Partial<ValueSignal>)
				: undefined,
			relatedDocs: JSON.parse(r.related) as string[],
			provenance: {
				author: r.author,
				model: r.model ?? undefined,
				timestamp: r.ts,
			},
		};
	}

	relink(oldDocId: string, newDocId: string): void {
		// Best-effort: if the new id already has an annotation, keep it and drop the old.
		const exists = this.db
			.prepare("SELECT 1 FROM annotations WHERE doc_id = ?")
			.get(newDocId);
		if (exists) {
			this.db.prepare("DELETE FROM annotations WHERE doc_id = ?").run(oldDocId);
			return;
		}
		this.db
			.prepare("UPDATE annotations SET doc_id = ? WHERE doc_id = ?")
			.run(newDocId, oldDocId);
	}

	close(): void {
		this.db.close();
	}
}
