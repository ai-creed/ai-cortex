// src/lib/library/__tests__/annotation-store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryAnnotationStore } from "../store/annotation-store.js";

describe("LibraryAnnotationStore", () => {
	let cacheHome: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-anno-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(cacheHome, { recursive: true, force: true });
	});

	it("writes and reads an annotation by docId", () => {
		const store = LibraryAnnotationStore.open("src1");
		store.upsert({
			docId: "d1",
			summary: "a summary",
			labels: ["x"],
			topics: ["t1", "t2"],
			relatedDocs: ["d2"],
			provenance: {
				author: "librarian",
				model: "cheap-llm",
				timestamp: "2026-06-23T00:00:00Z",
			},
		});
		const got = store.get("d1");
		expect(got?.summary).toBe("a summary");
		expect(got?.topics).toEqual(["t1", "t2"]);
		expect(got?.relatedDocs).toEqual(["d2"]);
		expect(store.get("missing")).toBeNull();
		store.close();
	});

	it("survives a reopen (simulated reindex) and relinks across rename", () => {
		let store = LibraryAnnotationStore.open("src1");
		store.upsert({
			docId: "old",
			labels: [],
			topics: [],
			relatedDocs: [],
			provenance: { author: "a", timestamp: "t" },
		});
		store.close();
		store = LibraryAnnotationStore.open("src1"); // reindex reopens the same file
		expect(store.get("old")).not.toBeNull();
		store.relink("old", "new");
		expect(store.get("old")).toBeNull();
		expect(store.get("new")).not.toBeNull();
		store.close();
	});
});
