// src/lib/library/__tests__/retriever.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexSource } from "../indexer.js";
import { retrieve } from "../retriever.js";
import { registerSource } from "../source-registry.js";
import { updateSource } from "../source-registry.js";
import type { Embedder, SourceRecord } from "../types.js";

function fakeEmbedder(dim = 8): Embedder {
	return {
		modelId: "fake-test-model",
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

describe("retrieve", () => {
	let cacheHome: string;
	let dirA: string;
	let dirB: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-ret-cache-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		dirA = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-ret-a-")),
		);
		dirB = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-ret-b-")),
		);
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		for (const d of [cacheHome, dirA, dirB])
			fs.rmSync(d, { recursive: true, force: true });
	});
	function write(dir: string, rel: string, content: string) {
		const abs = path.join(dir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	async function registerAndIndex(
		dir: string,
		repoKey?: string,
	): Promise<SourceRecord> {
		const { source } = registerSource({ rootPath: dir, nowIso: "t" });
		const withOrigin = repoKey
			? updateSource(source.id, {
					origin: { ...source.origin, repoKey },
					kind: "repo",
				})!
			: source;
		await indexSource(withOrigin, fakeEmbedder());
		return withOrigin;
	}

	it("returns lexically matching cited passages", async () => {
		write(
			dirA,
			"topic.md",
			"# Caching\nWe use an LRU cache with TTL eviction for sessions.\n",
		);
		await registerAndIndex(dirA);
		const hits = await retrieve("LRU cache eviction", fakeEmbedder());
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].snippet).toContain("LRU");
		expect(hits[0].citation.relPath).toBe("topic.md");
		expect(hits[0].citation.lineStart).toBeGreaterThanOrEqual(1);
		expect(hits[0].citation.filePath).toBe(path.join(dirA, "topic.md"));
	});

	it("ranks a same-origin doc above an equally-relevant other-origin doc", async () => {
		write(
			dirA,
			"x.md",
			"# Auth\nThe retry budget is three attempts with backoff.\n",
		);
		write(
			dirB,
			"y.md",
			"# Auth\nThe retry budget is three attempts with backoff.\n",
		);
		const a = await registerAndIndex(dirA, "repokeyAAAAAAAAA");
		await registerAndIndex(dirB, "repokeyBBBBBBBBB");
		const hits = await retrieve(
			"retry budget attempts backoff",
			fakeEmbedder(),
			{
				currentRepoKey: "repokeyAAAAAAAAA",
			},
		);
		expect(hits.length).toBeGreaterThanOrEqual(2);
		expect(hits[0].origin.repoKey).toBe("repokeyAAAAAAAAA");
		expect(hits[0].citation.sourceId).toBe(a.id);
	});

	it("flags a hit as stale when the file changed after indexing", async () => {
		write(dirA, "doc.md", "# Note\noriginal content about widgets\n");
		const src = await registerAndIndex(dirA);
		// mutate the file and bump mtime past the manifest record
		const future = new Date(Date.now() + 60_000);
		fs.writeFileSync(
			path.join(dirA, "doc.md"),
			"# Note\nedited content about widgets\n",
		);
		fs.utimesSync(path.join(dirA, "doc.md"), future, future);
		const hits = await retrieve("widgets", fakeEmbedder(), {
			sourceFilter: [src.id],
		});
		expect(hits[0].freshness).toBe("stale");
	});

	it("caps results at topN (precision-first)", async () => {
		for (let i = 0; i < 20; i++)
			write(
				dirA,
				`d${i}.md`,
				`# Doc ${i}\nshared keyword apple here number ${i}\n`,
			);
		await registerAndIndex(dirA);
		const hits = await retrieve("apple keyword", fakeEmbedder(), { topN: 5 });
		expect(hits.length).toBeLessThanOrEqual(5);
	});

	it("returns empty for an empty corpus", async () => {
		const hits = await retrieve("anything", fakeEmbedder());
		expect(hits).toEqual([]);
	});

	it("falls back to lexical-only when no embedder is available", async () => {
		write(
			dirA,
			"topic.md",
			"# Caching\nWe use an LRU cache with TTL eviction for sessions.\n",
		);
		await registerAndIndex(dirA);
		const hits = await retrieve("LRU cache eviction", null);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].citation.relPath).toBe("topic.md");
	});

	it("falls back to lexical-only when the embedder throws (model failure)", async () => {
		write(
			dirA,
			"topic.md",
			"# Caching\nWe use an LRU cache with TTL eviction for sessions.\n",
		);
		await registerAndIndex(dirA);
		const throwing: Embedder = {
			modelId: "broken",
			dim: 8,
			embed: async () => {
				throw new Error("model load failed");
			},
		};
		const hits = await retrieve("LRU cache eviction", throwing);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].citation.relPath).toBe("topic.md");
	});
});
