// src/lib/library/__tests__/index-store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryIndexStore } from "../store/index-store.js";
import type { Passage } from "../types.js";

const DIM = 4;
function vec(values: number[]): Float32Array {
	const v = Float32Array.from(values);
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n) || 1;
	return v.map((x) => x / n);
}
function passage(docId: string, ordinal: number, text: string): Passage {
	return {
		docId,
		ordinal,
		headingPath: ["Top", `H${ordinal}`],
		text,
		lineStart: ordinal * 10 + 1,
		lineEnd: ordinal * 10 + 9,
		contentHash: "hash-" + docId,
	};
}

describe("LibraryIndexStore", () => {
	let cacheHome: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-store-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(cacheHome, { recursive: true, force: true });
	});

	it("stores docs/passages, full-text searches, and re-derives counts", () => {
		const store = LibraryIndexStore.open("src1", DIM);
		store.replaceDoc(
			{
				docId: "d1",
				relPath: "a.md",
				docType: "doc",
				statusHeader: null,
				mtimeMs: 100,
				pinned: 0,
				contentHash: "hash-d1",
			},
			[
				{
					passage: passage("d1", 0, "alpha beta gamma"),
					vector: vec([1, 0, 0, 0]),
				},
			],
		);
		expect(store.passageCount()).toBe(1);
		const hits = store.searchFts("beta", 10);
		expect(hits.length).toBe(1);
		const rows = store.loadPassages([hits[0].passageId]);
		expect(rows[0].text).toBe("alpha beta gamma");
		expect(rows[0].relPath).toBe("a.md");
		expect(rows[0].headingPath).toEqual(["Top", "H0"]);
		expect(rows[0].lineStart).toBe(1);
		store.close();
	});

	it("semanticTopK returns the nearest vector first and respects k", () => {
		const store = LibraryIndexStore.open("src1", DIM);
		store.replaceDoc(
			{
				docId: "d1",
				relPath: "a.md",
				docType: "doc",
				statusHeader: null,
				mtimeMs: 1,
				pinned: 0,
				contentHash: "h",
			},
			[
				{ passage: passage("d1", 0, "near"), vector: vec([1, 0, 0, 0]) },
				{ passage: passage("d1", 1, "far"), vector: vec([0, 1, 0, 0]) },
				{ passage: passage("d1", 2, "mid"), vector: vec([0.7, 0.7, 0, 0]) },
			],
		);
		const top = store.semanticTopK(vec([1, 0, 0, 0]), 2);
		expect(top.length).toBe(2);
		const best = store.loadPassages([top[0].passageId])[0];
		expect(best.text).toBe("near");
		expect(top[0].score).toBeGreaterThan(top[1].score);
		store.close();
	});

	it("deleteDoc removes its passages and fts rows", () => {
		const store = LibraryIndexStore.open("src1", DIM);
		store.replaceDoc(
			{
				docId: "d1",
				relPath: "a.md",
				docType: "doc",
				statusHeader: null,
				mtimeMs: 1,
				pinned: 0,
				contentHash: "h",
			},
			[
				{
					passage: passage("d1", 0, "deleteme token"),
					vector: vec([1, 0, 0, 0]),
				},
			],
		);
		store.deleteDoc("d1");
		expect(store.passageCount()).toBe(0);
		expect(store.searchFts("deleteme", 10).length).toBe(0);
		store.close();
	});

	it("replaceDoc on an existing docId replaces, not duplicates", () => {
		const store = LibraryIndexStore.open("src1", DIM);
		const doc = {
			docId: "d1",
			relPath: "a.md",
			docType: "doc",
			statusHeader: null,
			mtimeMs: 1,
			pinned: 0,
			contentHash: "h",
		};
		store.replaceDoc(doc, [
			{ passage: passage("d1", 0, "v1 content"), vector: vec([1, 0, 0, 0]) },
		]);
		store.replaceDoc(doc, [
			{ passage: passage("d1", 0, "v2 content"), vector: vec([1, 0, 0, 0]) },
		]);
		expect(store.passageCount()).toBe(1);
		expect(store.searchFts("v1", 10).length).toBe(0);
		expect(store.searchFts("v2", 10).length).toBe(1);
		const map = store.allDocRelPaths();
		expect(map.get("a.md")?.docId).toBe("d1");
		store.close();
	});
});
