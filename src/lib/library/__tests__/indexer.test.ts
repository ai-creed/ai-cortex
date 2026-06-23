// src/lib/library/__tests__/indexer.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexSource } from "../indexer.js";
import { LibraryIndexStore } from "../store/index-store.js";
import { LibraryAnnotationStore } from "../store/annotation-store.js";
import { indexDbPath, manifestPath } from "../paths.js";
import { hashId } from "../util/ids.js";
import type { Embedder, Manifest, SourceRecord } from "../types.js";

function fakeEmbedder(dim = 8, modelId = "fake-test-model"): Embedder {
	return {
		modelId,
		dim,
		async embed(texts) {
			return texts.map((t) => {
				const v = new Float32Array(dim);
				for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 100;
				let n = 0;
				for (let j = 0; j < dim; j++) n += v[j]! * v[j]!;
				n = Math.sqrt(n) || 1;
				for (let j = 0; j < dim; j++) v[j]! /= n;
				return v;
			});
		},
	};
}

describe("indexSource", () => {
	let cacheHome: string;
	let root: string;
	let source: SourceRecord;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-idx-cache-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-idx-src-")),
		);
		source = {
			id: hashId(root),
			rootPath: root,
			kind: "dir",
			origin: { name: "fix" },
			includeGlobs: [],
			excludeGlobs: [],
			addedAt: "t",
			lastIndexedAt: null,
			status: "ok",
		};
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(cacheHome, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	});
	function write(rel: string, content: string) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	function readManifest(): Manifest {
		return JSON.parse(
			fs.readFileSync(manifestPath(source.id), "utf8"),
		) as Manifest;
	}

	it("builds an index and writes a model-aware manifest", async () => {
		write("a.md", "# A\nalpha content here\n");
		write("b.md", "# B\nbeta content here\n");
		const res = await indexSource(source, fakeEmbedder());
		expect(res.docsIndexed).toBe(2);
		expect(res.passages).toBeGreaterThanOrEqual(2);
		const store = LibraryIndexStore.open(source.id, 8);
		expect(store.passageCount()).toBe(res.passages);
		store.close();
		const m = readManifest();
		expect(m.modelId).toBe("fake-test-model");
		expect(m.dim).toBe(8);
		expect(Object.keys(m.files).sort()).toEqual(["a.md", "b.md"]);
		expect(m.files["a.md"].completed).toBe(true);
	});

	it("is incremental: unchanged skipped, changed re-embedded, deleted purged (minimal rework)", async () => {
		write("a.md", "# A\nalpha stable\n");
		write("b.md", "# B\nbeta\n");
		write("d.md", "# D\ndelta\n");
		const first = await indexSource(source, fakeEmbedder());
		expect(first.docsIndexed).toBe(3);
		const m1 = readManifest();
		const aHash1 = m1.files["a.md"].contentHash;
		const bHash1 = m1.files["b.md"].contentHash;

		write("b.md", "# B\nbeta CHANGED\n"); // change b only
		write("c.md", "# C\ngamma\n"); // add c
		fs.rmSync(path.join(root, "d.md")); // delete d; a stays unchanged
		const second = await indexSource(source, fakeEmbedder());

		// minimal rework: only the changed (b) and added (c) docs are reprocessed.
		expect(second.docsIndexed).toBe(2);
		expect(second.docsDeleted).toBe(1);
		const m2 = readManifest();
		expect(Object.keys(m2.files).sort()).toEqual(["a.md", "b.md", "c.md"]);
		expect(m2.files["a.md"].contentHash).toBe(aHash1); // unchanged file skipped
		expect(m2.files["b.md"].contentHash).not.toBe(bHash1); // changed file re-embedded
	});

	it("relinks an annotation when a file is renamed with identical content", async () => {
		write("old.md", "# Doc\nstable body text\n");
		await indexSource(source, fakeEmbedder());
		const oldDocId = hashId(source.id, "old.md");
		const anno = LibraryAnnotationStore.open(source.id);
		anno.upsert({
			docId: oldDocId,
			labels: ["keep"],
			topics: [],
			relatedDocs: [],
			provenance: { author: "t", timestamp: "t" },
		});
		anno.close();

		fs.rmSync(path.join(root, "old.md"));
		write("new.md", "# Doc\nstable body text\n"); // identical content, new path
		await indexSource(source, fakeEmbedder());

		const newDocId = hashId(source.id, "new.md");
		const anno2 = LibraryAnnotationStore.open(source.id);
		expect(anno2.get(oldDocId)).toBeNull();
		expect(anno2.get(newDocId)?.labels).toEqual(["keep"]);
		anno2.close();
	});

	it("rebuilds fully when the embedding model changes", async () => {
		write("a.md", "# A\nalpha\n");
		await indexSource(source, fakeEmbedder(8, "model-v1"));
		const res = await indexSource(source, fakeEmbedder(8, "model-v2"));
		expect(res.modelChanged).toBe(true);
		expect(readManifest().modelId).toBe("model-v2");
	});

	it("throws when the source root is missing or unreadable", async () => {
		const gone = { ...source, rootPath: path.join(root, "does-not-exist") };
		await expect(indexSource(gone, fakeEmbedder())).rejects.toThrow(
			/missing or unreadable/,
		);
	});

	it("rebuilds a corrupt index from source while preserving annotations", async () => {
		write("a.md", "# A\nalpha body here\n");
		await indexSource(source, fakeEmbedder());
		const docId = hashId(source.id, "a.md");
		const anno = LibraryAnnotationStore.open(source.id);
		anno.upsert({
			docId,
			labels: ["keep"],
			topics: [],
			relatedDocs: [],
			provenance: { author: "t", timestamp: "t" },
		});
		anno.close();

		fs.writeFileSync(indexDbPath(source.id), "this is not a sqlite database");
		const res = await indexSource(source, fakeEmbedder());
		expect(res.docsIndexed).toBe(1); // rebuilt from source

		const store = LibraryIndexStore.open(source.id, 8);
		expect(store.passageCount()).toBeGreaterThan(0);
		store.close();

		const anno2 = LibraryAnnotationStore.open(source.id);
		expect(anno2.get(docId)?.labels).toEqual(["keep"]); // annotations preserved across rebuild
		anno2.close();
	});

	it("rebuilds from source when the index is locked", async () => {
		write("a.md", "# A\nalpha body here\n");
		await indexSource(source, fakeEmbedder());

		// Hold a write lock on the index from a separate connection.
		const Database = (await import("better-sqlite3")).default;
		const locker = new Database(indexDbPath(source.id));
		locker.pragma("busy_timeout = 0");
		locker.exec("BEGIN IMMEDIATE"); // acquire the write lock
		try {
			const res = await indexSource(source, fakeEmbedder());
			expect(res.docsIndexed).toBe(1); // rebuilt despite the lock
		} finally {
			try {
				locker.exec("ROLLBACK");
			} catch {
				/* the locked file may have been unlinked during rebuild */
			}
			locker.close();
		}

		const store = LibraryIndexStore.open(source.id, 8);
		expect(store.passageCount()).toBeGreaterThan(0);
		store.close();
	});
});
